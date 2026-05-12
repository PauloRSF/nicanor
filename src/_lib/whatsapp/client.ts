import {
	DisconnectReason,
	downloadContentFromMessage,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	makeWASocket,
	type proto,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "baileys";
import PQueue from "p-queue";
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

type MessageEventHandler<T> = (event: T) => void | Promise<void>;

export type WhatsAppClient = {
	onTextMessage: (cb: MessageEventHandler<TextMessageEvent>) => void;
	onStickerMessage: (cb: MessageEventHandler<StickerMessageEvent>) => void;
	onImageMessage: (cb: MessageEventHandler<ImageMessageEvent>) => void;
	onGifMessage: (cb: MessageEventHandler<GifMessageEvent>) => void;
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

	let onText: MessageEventHandler<TextMessageEvent> | null = null;
	let onSticker: MessageEventHandler<StickerMessageEvent> | null = null;
	let onImage: MessageEventHandler<ImageMessageEvent> | null = null;
	let onGif: MessageEventHandler<GifMessageEvent> | null = null;

	let connectedAt = 0;

	const incomingQueuesByJid = new Map<string, PQueue>();

	function incomingQueueFor(jid: string): PQueue {
		let queue = incomingQueuesByJid.get(jid);

		if (!queue) {
			queue = new PQueue({ concurrency: 1, autoStart: true });

			queue.once("idle", () => incomingQueuesByJid.delete(jid));

			incomingQueuesByJid.set(jid, queue);
		}

		return queue;
	}

	function getRemoteIncomingJid(msg: WAMessage): string | null {
		const { message, key, messageTimestamp } = msg;

		if (!message || key.fromMe) return null;

		const timestamp = typeof messageTimestamp === "number" ? messageTimestamp : Number(messageTimestamp);

		if (timestamp < connectedAt) return null;

		return key.remoteJid ?? null;
	}

	function hasDispatchablePayload(message: proto.IMessage): boolean {
		const text = message.conversation ?? message.extendedTextMessage?.text;

		return (
			!!message.stickerMessage ||
			!!message.imageMessage ||
			message.videoMessage?.gifPlayback === true ||
			(!!message.documentMessage && isGifDocumentFile(message.documentMessage)) ||
			!!text
		);
	}

	async function handleIncomingMessage(msg: WAMessage): Promise<void> {
		const socket = currentSocket;
		if (!socket) return;

		try {
			const jid = getRemoteIncomingJid(msg);

			if (!jid) return;

			const { message } = msg;
			if (!message) return;

			const text = message.conversation ?? message.extendedTextMessage?.text;

			if (message.stickerMessage) {
				const stickerBytes = await downloadMediaToBuffer(message.stickerMessage, "sticker");

				await Promise.resolve(onSticker?.({ jid, socket, stickerBytes }));
			} else if (message.imageMessage) {
				const imageBytes = await downloadMediaToBuffer(message.imageMessage, "image");

				await Promise.resolve(onImage?.({ jid, socket, imageBytes }));
			} else if (message.videoMessage?.gifPlayback === true) {
				const gifBytes = await downloadMediaToBuffer(message.videoMessage, "gif");

				await Promise.resolve(onGif?.({ jid, socket, gifBytes, gifInputExt: "mp4" }));
			} else if (message.documentMessage && isGifDocumentFile(message.documentMessage)) {
				const gifBytes = await downloadMediaToBuffer(message.documentMessage, "document");

				await Promise.resolve(onGif?.({ jid, socket, gifBytes, gifInputExt: "gif" }));
			} else if (text) {
				await Promise.resolve(onText?.({ jid, socket, text }));
			}
		} catch (err) {
			logger.error(err, "Error processing incoming message");
		}
	}

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

				const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;

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

				logger.info(`Retry ${retryCount}/${maxRetries} in ${(delay / 1000).toFixed(0)}s...`);

				setTimeout(connectSocket, delay);
			}
		});

		socket.ev.on("messages.upsert", ({ messages }) => {
			for (const msg of messages) {
				const jid = getRemoteIncomingJid(msg);

				if (!jid) continue;

				if (!msg.message || !hasDispatchablePayload(msg.message)) continue;

				void incomingQueueFor(jid)
					.add(() => handleIncomingMessage(msg))
					.catch((err) => {
						logger.error(err, "Incoming message queue error");
					});
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
