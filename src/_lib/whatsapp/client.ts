import {
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type proto,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";

import { logger } from "../logger.js";

type MessageContext = { jid: string; socket: WASocket };
type TextMessageEvent = MessageContext & { text: string };
type StickerMessageEvent = MessageContext & { stickerBytes: Buffer };
type ImageMessageEvent = MessageContext & { imageBytes: Buffer };
type GifMessageEvent = MessageContext & {
  gifBytes: Buffer;
  gifInputExt: "mp4" | "gif";
};

export type WhatsAppClient = {
  onTextMessage: (cb: (event: TextMessageEvent) => void) => void;
  onStickerMessage: (cb: (event: StickerMessageEvent) => void) => void;
  onImageMessage: (cb: (event: ImageMessageEvent) => void) => void;
  onGifMessage: (cb: (event: GifMessageEvent) => void) => void;
  shutdown: () => void;
};

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 2_000;

const MAX_MEDIA_SIZE_BYTES = {
  sticker: 2 * 1024 * 1024,
  image: 4 * 1024 * 1024,
  gif: 8 * 1024 * 1024,
  document: 8 * 1024 * 1024,
};

function isGifDocumentFile(doc: proto.Message.IDocumentMessage): boolean {
  const mime = doc.mimetype?.toLowerCase() ?? "";
  if (mime === "image/gif" || mime.startsWith("image/gif;")) return true;
  const name = doc.fileName?.toLowerCase() ?? "";
  return name.endsWith(".gif");
}

async function downloadMediaToBuffer(
  message:
    | proto.Message.IStickerMessage
    | proto.Message.IImageMessage
    | proto.Message.IVideoMessage
    | proto.Message.IDocumentMessage,
  type: "sticker" | "image" | "gif" | "document",
): Promise<Buffer> {
  const stream = await downloadContentFromMessage(message, type);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = MAX_MEDIA_SIZE_BYTES[type];

  for await (const chunk of stream) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Media (type: ${type}) exceeds ${maxBytes} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

type CreateWhatsAppClientOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
};

export async function createWhatsAppClient({
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
}: CreateWhatsAppClientOptions = {}): Promise<WhatsAppClient> {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  logger.info(`Using WA version ${version.join(".")}`);

  let shuttingDown = false;
  let retryCount = 0;
  let currentSocket: WASocket | null = null;

  let onText: ((event: TextMessageEvent) => void) | null = null;
  let onSticker: ((event: StickerMessageEvent) => void) | null = null;
  let onImage: ((event: ImageMessageEvent) => void) | null = null;
  let onGif: ((event: GifMessageEvent) => void) | null = null;

  let connectedAt = 0;

  let bootResolve: () => void;
  let bootReject: (err: Error) => void;
  let booted = false;

  function connectSocket() {
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      printQRInTerminal: false,
      syncFullHistory: false,
    });

    currentSocket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        connectedAt = Math.floor(Date.now() / 1000);
        retryCount = 0;
        logger.info("Connected to WhatsApp!");

        if (!booted) {
          booted = true;
          bootResolve();
        }
      }

      if (connection === "close") {
        if (shuttingDown) return;

        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.error("Logged out from WhatsApp.");

          if (!booted) return bootReject(new Error("Logged out"));
          else process.exit(1);
        }

        retryCount++;

        if (retryCount > maxRetries) {
          const message = `Failed to connect after ${maxRetries} retries`;

          if (!booted) {
            return bootReject(new Error(message));
          } else {
            logger.error(`${message}. Exiting.`);
            process.exit(1);
          }
        }

        const delay = Math.min(baseDelayMs * 2 ** (retryCount - 1), 60_000);

        logger.info(
          `Retry ${retryCount}/${maxRetries} in ${(delay / 1000).toFixed(0)}s...`,
        );

        setTimeout(connectSocket, delay);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          const { message, key, messageTimestamp } = msg;

          if (!message || key.fromMe) continue;

          const timestamp =
            typeof messageTimestamp === "number"
              ? messageTimestamp
              : Number(messageTimestamp);

          if (timestamp < connectedAt) continue;

          const jid = key.remoteJid;

          if (!jid) continue;

          const text =
            message.conversation ?? message.extendedTextMessage?.text;

          if (message.stickerMessage) {
            const stickerBytes = await downloadMediaToBuffer(
              message.stickerMessage,
              "sticker",
            );

            onSticker?.({ jid, socket, stickerBytes });
          } else if (message.imageMessage) {
            const imageBytes = await downloadMediaToBuffer(
              message.imageMessage,
              "image",
            );

            onImage?.({ jid, socket, imageBytes });
          } else if (message.videoMessage?.gifPlayback === true) {
            const gifBytes = await downloadMediaToBuffer(
              message.videoMessage,
              "gif",
            );

            onGif?.({ jid, socket, gifBytes, gifInputExt: "mp4" });
          } else if (
            message.documentMessage &&
            isGifDocumentFile(message.documentMessage)
          ) {
            const gifBytes = await downloadMediaToBuffer(
              message.documentMessage,
              "document",
            );

            onGif?.({ jid, socket, gifBytes, gifInputExt: "gif" });
          } else if (text) {
            onText?.({ jid, socket, text });
          }
        } catch (err) {
          logger.error(err, "Error processing incoming message");
        }
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    bootResolve = resolve;
    bootReject = reject;
    connectSocket();
  });

  return {
    onTextMessage: (cb) => {
      onText = cb;
    },
    onStickerMessage: (cb) => {
      onSticker = cb;
    },
    onImageMessage: (cb) => {
      onImage = cb;
    },
    onGifMessage: (cb) => {
      onGif = cb;
    },
    shutdown: () => {
      shuttingDown = true;
      currentSocket?.end(undefined);
    },
  };
}
