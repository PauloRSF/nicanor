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

import { logger } from "./logger.js";

type MessageContext = { jid: string; socket: WASocket };
type TextMessageEvent = MessageContext & { text: string };
type StickerMessageEvent = MessageContext & { stickerBytes: Buffer };

export type WhatsAppClient = {
	onTextMessage: (cb: (event: TextMessageEvent) => void) => void;
	onStickerMessage: (cb: (event: StickerMessageEvent) => void) => void;
	shutdown: () => void;
};

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 2_000;
const MAX_STICKER_BYTES = 2 * 1024 * 1024;

async function downloadSticker(stickerMessage: proto.Message.IStickerMessage): Promise<Buffer> {
	const stream = await downloadContentFromMessage(stickerMessage, "sticker");

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of stream) {
		totalBytes += chunk.length;
		if (totalBytes > MAX_STICKER_BYTES) {
			throw new Error(`Sticker exceeds ${MAX_STICKER_BYTES} byte limit`);
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

		socket.ev.on("messages.upsert", async ({ messages }) => {
			for (const { message, key } of messages) {
				try {
					if (!message || key.fromMe) continue;

					const jid = key.remoteJid;

					if (!jid) continue;

					const text = message.conversation ?? message.extendedTextMessage?.text;

					if (message.stickerMessage) {
						const stickerBytes = await downloadSticker(message.stickerMessage);

						onSticker?.({ jid, socket, stickerBytes });
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
		shutdown: () => {
			shuttingDown = true;
			currentSocket?.end(undefined);
		},
	};
}
