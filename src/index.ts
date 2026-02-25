import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from "baileys";
import fs from "fs";
import qrcode from "qrcode-terminal";
import { initDb, upsertSticker, getStickerByHash } from "./db/index.js";
import { downloadAndSaveSticker } from "./sticker.js";
import { handleCommand } from "./commands.js";

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 2_000;

let retryCount = 0;

async function startBot(): Promise<void> {
  initDb();
  console.log("Database initialized.");

  const { version } = await fetchLatestBaileysVersion();
  console.log(`Using WA version ${version.join(".")}`);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock: WASocket = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    version,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Connected to WhatsApp!");
      retryCount = 0;
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Connection closed (status ${statusCode}). ${shouldReconnect ? "Reconnecting..." : "Logged out."}`
      );

      if (shouldReconnect) {
        retryCount++;
        if (retryCount > MAX_RETRIES) {
          console.error(
            `Max retries (${MAX_RETRIES}) reached. Exiting. Try again later.`
          );
          process.exit(1);
        }
        const delay = Math.min(BASE_DELAY_MS * 2 ** (retryCount - 1), 60_000);
        console.log(
          `Retry ${retryCount}/${MAX_RETRIES} in ${(delay / 1000).toFixed(0)}s...`
        );
        setTimeout(startBot, delay);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid) continue;

      try {
        await processMessage(sock, jid, msg);
      } catch (err) {
        console.error("Error processing message:", err);
      }
    }
  });
}

async function processMessage(
  sock: WASocket,
  jid: string,
  msg: proto.IWebMessageInfo
): Promise<void> {
  const message = msg.message!;

  const stickerMessage = message.stickerMessage;
  if (stickerMessage) {
    console.log(`Sticker received from ${jid}`);
    const { filePath, fileHash } =
      await downloadAndSaveSticker(stickerMessage);

    const existing = getStickerByHash(fileHash);
    const wasRecovered = existing && !fs.existsSync(existing.file_path);

    const sticker = upsertSticker(filePath, fileHash, jid);
    console.log(`Saved sticker #${sticker.id} (${fileHash.slice(0, 8)}...)`);

    const text = wasRecovered
      ? `Sticker image recovered! The file was missing but your tags are intact.`
      : `Sticker received! Use *!tag tag1 tag2 ...* to tag it.\nUse *!help* to see all commands.`;
    await sock.sendMessage(jid, { text });
    return;
  }

  const textContent =
    message.conversation || message.extendedTextMessage?.text;
  if (textContent && textContent.startsWith("!")) {
    await handleCommand(sock, jid, textContent);
  }
}

startBot().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// 920015322