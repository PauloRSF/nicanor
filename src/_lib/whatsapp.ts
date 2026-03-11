import { spawn } from "node:child_process";
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
import _ffmpegPath from "ffmpeg-static";
import qrcode from "qrcode-terminal";
import sharp from "sharp";

import { logger } from "./logger.js";

const ffmpegPath = _ffmpegPath as unknown as string | null;

type MessageContext = { jid: string; socket: WASocket };
type TextMessageEvent = MessageContext & { text: string };
type StickerMessageEvent = MessageContext & { stickerBytes: Buffer };
type ImageMessageEvent = MessageContext & { imageBytes: Buffer };
type GifMessageEvent = MessageContext & { gifBytes: Buffer };
type VideoMessageEvent = MessageContext & { videoBytes: Buffer };

export type WhatsAppClient = {
	onTextMessage: (cb: (event: TextMessageEvent) => void) => void;
	onStickerMessage: (cb: (event: StickerMessageEvent) => void) => void;
	onImageMessage: (cb: (event: ImageMessageEvent) => void) => void;
	onGifMessage: (cb: (event: GifMessageEvent) => void) => void;
	onVideoMessage: (cb: (event: VideoMessageEvent) => void) => void;
	shutdown: () => void;
};

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 2_000;
const MAX_STICKER_BYTES = 2 * 1024 * 1024;

async function downloadMedia(
	message: proto.Message.IStickerMessage | proto.Message.IImageMessage | proto.Message.IVideoMessage,
	type: "sticker" | "image" | "video",
): Promise<Buffer> {
	const stream = await downloadContentFromMessage(message, type);

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of stream) {
		totalBytes += chunk.length;
		if (totalBytes > MAX_STICKER_BYTES) {
			throw new Error(`Media (type: ${type}) exceeds ${MAX_STICKER_BYTES} byte limit`);
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
	let onVideo: ((event: VideoMessageEvent) => void) | null = null;

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
			for (const msg of messages) {
				try {
					const { message, key, messageTimestamp } = msg;

					if (!message || key.fromMe) continue;

					const timestamp = typeof messageTimestamp === "number" ? messageTimestamp : Number(messageTimestamp);

					if (timestamp < connectedAt) continue;

					const jid = key.remoteJid;

					if (!jid) continue;

					const text = message.conversation ?? message.extendedTextMessage?.text;

					if (message.stickerMessage) {
						const stickerBytes = await downloadMedia(message.stickerMessage, "sticker");

						onSticker?.({ jid, socket, stickerBytes });
					} else if (message.imageMessage) {
						const imageBytes = await downloadMedia(message.imageMessage, "image");

						onImage?.({ jid, socket, imageBytes });
					} else if (message.videoMessage?.gifPlayback) {
						const gifBytes = await downloadMedia(message.videoMessage, "video");

						onGif?.({ jid, socket, gifBytes });
					} else if (message.videoMessage) {
						const videoBytes = await downloadMedia(message.videoMessage, "video");

						onVideo?.({ jid, socket, videoBytes });
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
		onVideoMessage: (cb) => {
			onVideo = cb;
		},
		shutdown: () => {
			shuttingDown = true;
			currentSocket?.end(undefined);
		},
	};
}

const STICKER_SIZE = 512;

export async function imageToSticker(imageBytes: Buffer): Promise<Buffer> {
	return sharp(imageBytes)
		.resize(STICKER_SIZE, STICKER_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.webp()
		.toBuffer();
}

export function gifToSticker(mp4Bytes: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (!ffmpegPath) return reject(new Error("ffmpeg-static binary not found"));

		const ffmpeg = spawn(ffmpegPath, [
			"-i",
			"pipe:0",
			"-vf",
			`scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,pad=${STICKER_SIZE}:${STICKER_SIZE}:-1:-1:color=#00000000,fps=15`,
			"-loop",
			"0",
			"-an",
			"-f",
			"webp",
			"pipe:1",
		]);

		const chunks: Buffer[] = [];

		ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		ffmpeg.stderr.on("data", () => {});

		ffmpeg.on("close", (code) => {
			if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
			resolve(Buffer.concat(chunks));
		});

		ffmpeg.on("error", (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)));

		ffmpeg.stdin.write(mp4Bytes);
		ffmpeg.stdin.end();
	});
}
