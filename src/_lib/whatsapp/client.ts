import {
	DisconnectReason,
	downloadContentFromMessage,
	extractMessageContent,
	fetchLatestBaileysVersion,
	type GroupMetadata,
	makeCacheableSignalKeyStore,
	makeWASocket,
	type proto,
	useMultiFileAuthState,
	type WAMessage,
	type WAMessageKey,
	type WASocket,
} from "baileys";
import PQueue from "p-queue";
import qrcode from "qrcode-terminal";

import { logger } from "../logger.js";

const RECENT_OUTBOUND_TTL_MS = 10 * 60 * 1000;

export type MessageContext = {
	jid: string;
	socket: WASocket;
	isGroup: boolean;
	sourceMessage: WAMessage;
};

type TextMessageEvent = MessageContext & { text: string };
type StickerMessageEvent = MessageContext & { stickerBytes: Buffer };
type ImageMessageEvent = MessageContext & { imageBytes: Buffer };
type GifMessageEvent = MessageContext & {
	gifBytes: Buffer;
	gifInputExt: "mp4" | "gif";
};
type VideoMessageEvent = MessageContext & { videoBytes: Buffer };

type MessageEventHandler<T> = (event: T) => void | Promise<void>;

export type WhatsAppClient = {
	onTextMessage: (cb: MessageEventHandler<TextMessageEvent>) => void;
	onStickerMessage: (cb: MessageEventHandler<StickerMessageEvent>) => void;
	onImageMessage: (cb: MessageEventHandler<ImageMessageEvent>) => void;
	onGifMessage: (cb: MessageEventHandler<GifMessageEvent>) => void;
	onVideoMessage: (cb: MessageEventHandler<VideoMessageEvent>) => void;
	shutdown: () => void;
};

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 2_000;

const MAX_MEDIA_SIZE_BYTES = {
	sticker: 2 * 1024 * 1024,
	image: 4 * 1024 * 1024,
	gif: 8 * 1024 * 1024,
	video: 16 * 1024 * 1024,
	document: 8 * 1024 * 1024,
};

function isGroupJid(jid: string): boolean {
	return jid.endsWith("@g.us");
}

function normalizeJid(jid: string): string {
	const at = jid.indexOf("@");
	if (at < 0) return jid;

	const user = jid.slice(0, at);
	const server = jid.slice(at + 1);
	return `${user.split(":")[0]}@${server}`;
}

function botIdCandidates(socket: WASocket): string[] {
	const me = socket.user;

	if (!me) return [];

	return [me.id, me.lid, me.phoneNumber].filter((value): value is string => Boolean(value)).map(normalizeJid);
}

function isBotMentioned(socket: WASocket, mentionedJid?: string[] | null): boolean {
	if (!mentionedJid?.length) return false;

	const mine = new Set(botIdCandidates(socket));

	return mentionedJid.some((jid) => mine.has(normalizeJid(jid)));
}

function getMessageContextInfo(message: proto.IMessage): proto.IContextInfo | undefined | null {
	return (
		message.extendedTextMessage?.contextInfo ??
		message.imageMessage?.contextInfo ??
		message.videoMessage?.contextInfo ??
		message.documentMessage?.contextInfo ??
		message.stickerMessage?.contextInfo
	);
}

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
	type: "sticker" | "image" | "gif" | "video" | "document",
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

type DownloadedMedia =
	| { kind: "image"; imageBytes: Buffer }
	| { kind: "gif"; gifBytes: Buffer; gifInputExt: "mp4" | "gif" }
	| { kind: "video"; videoBytes: Buffer };

async function downloadMessageMedia(raw: proto.IMessage): Promise<DownloadedMedia | null> {
	const message = extractMessageContent(raw) ?? raw;

	if (message.imageMessage) {
		return { kind: "image", imageBytes: await downloadMediaToBuffer(message.imageMessage, "image") };
	}

	if (message.videoMessage?.gifPlayback === true) {
		return {
			kind: "gif",
			gifBytes: await downloadMediaToBuffer(message.videoMessage, "gif"),
			gifInputExt: "mp4",
		};
	}

	if (message.videoMessage) {
		return { kind: "video", videoBytes: await downloadMediaToBuffer(message.videoMessage, "video") };
	}

	if (message.documentMessage && isGifDocumentFile(message.documentMessage)) {
		return {
			kind: "gif",
			gifBytes: await downloadMediaToBuffer(message.documentMessage, "document"),
			gifInputExt: "gif",
		};
	}

	return null;
}

function startsWithCommand(text: string): boolean {
	return text.trimStart().startsWith("!");
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
	let onVideo: MessageEventHandler<VideoMessageEvent> | null = null;

	let connectedAt = 0;

	const incomingQueuesByJid = new Map<string, PQueue>();
	const groupCache = new Map<string, GroupMetadata>();
	const recentOutbound = new Map<string, proto.IMessage>();

	function incomingQueueFor(jid: string): PQueue {
		let queue = incomingQueuesByJid.get(jid);

		if (!queue) {
			queue = new PQueue({ concurrency: 1, autoStart: true });

			queue.once("idle", () => incomingQueuesByJid.delete(jid));

			incomingQueuesByJid.set(jid, queue);
		}

		return queue;
	}

	function rememberOutboundMessage(key: WAMessageKey | undefined | null, message: proto.IMessage | undefined | null) {
		const id = key?.id;
		if (!id || !message) return;

		recentOutbound.set(id, message);
		setTimeout(() => recentOutbound.delete(id), RECENT_OUTBOUND_TTL_MS);
	}

	function cacheGroupMetadata(metadata: GroupMetadata) {
		if (!metadata.id) return;
		groupCache.set(metadata.id, metadata);
	}

	async function ensureGroupMetadata(socket: WASocket, jid: string): Promise<void> {
		if (groupCache.has(jid)) return;

		try {
			cacheGroupMetadata(await socket.groupMetadata(jid));
		} catch (err) {
			logger.warn({ jid, err }, "Failed to load group metadata");
		}
	}

	function getRemoteIncomingJid(msg: WAMessage): string | null {
		const { message, key, messageTimestamp } = msg;

		if (!message || key.fromMe) return null;

		const timestamp = typeof messageTimestamp === "number" ? messageTimestamp : Number(messageTimestamp);

		if (timestamp < connectedAt) return null;

		return key.remoteJid ?? null;
	}

	function hasDispatchablePayload(raw: proto.IMessage): boolean {
		const message = extractMessageContent(raw) ?? raw;
		const text = message.conversation ?? message.extendedTextMessage?.text;
		const caption = message.imageMessage?.caption ?? message.videoMessage?.caption ?? message.documentMessage?.caption;

		return (
			!!message.stickerMessage ||
			!!message.imageMessage ||
			!!message.videoMessage ||
			(!!message.documentMessage && isGifDocumentFile(message.documentMessage)) ||
			!!text ||
			!!caption
		);
	}

	async function handleIncomingMessage(msg: WAMessage): Promise<void> {
		const socket = currentSocket;
		if (!socket) return;

		try {
			const jid = getRemoteIncomingJid(msg);

			if (!jid) return;

			if (!msg.message) return;

			const message = extractMessageContent(msg.message) ?? msg.message;
			const contextInfo = getMessageContextInfo(message);
			const isGroup = isGroupJid(jid);
			const mentionedBot = isBotMentioned(socket, contextInfo?.mentionedJid);

			// Stickers stay DM-only. Everything else: DMs always, groups only when @mentioned.
			if (message.stickerMessage) {
				if (isGroup) return;
			} else if (isGroup && !mentionedBot) {
				return;
			}

			// Warm group metadata before handlers send — avoids a live IQ on every sendMessage.
			if (isGroup) {
				await ensureGroupMetadata(socket, jid);
			}

			const base: MessageContext = { jid, socket, isGroup, sourceMessage: msg };
			const text = message.conversation ?? message.extendedTextMessage?.text;

			if (message.stickerMessage) {
				const stickerBytes = await downloadMediaToBuffer(message.stickerMessage, "sticker");

				await Promise.resolve(onSticker?.({ ...base, stickerBytes }));
				return;
			}

			async function dispatchMedia(media: DownloadedMedia): Promise<void> {
				if (media.kind === "image") {
					await Promise.resolve(onImage?.({ ...base, imageBytes: media.imageBytes }));
					return;
				}

				if (media.kind === "gif") {
					await Promise.resolve(onGif?.({ ...base, gifBytes: media.gifBytes, gifInputExt: media.gifInputExt }));
					return;
				}

				await Promise.resolve(onVideo?.({ ...base, videoBytes: media.videoBytes }));
			}

			const directMedia = await downloadMessageMedia(message);

			if (directMedia) {
				await dispatchMedia(directMedia);
				return;
			}

			if (!text) return;

			// Reply-to-media: treat quoted media like a normal media message. In DMs, !commands
			// still win; in groups commands are disabled so quoted media always wins.
			if (contextInfo?.quotedMessage && (isGroup || !startsWithCommand(text))) {
				try {
					const quotedMedia = await downloadMessageMedia(contextInfo.quotedMessage);

					if (quotedMedia) {
						await dispatchMedia(quotedMedia);
						return;
					}
				} catch (err) {
					logger.warn(err, "Failed to download quoted media");
				}
			}

			// Groups: no !commands (text handler also enforces this).
			if (isGroup && startsWithCommand(text)) {
				return;
			}

			await Promise.resolve(onText?.({ ...base, text }));
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
			cachedGroupMetadata: async (jid) => groupCache.get(jid),
			getMessage: async (key) => {
				const id = key.id;
				if (!id) return undefined;
				return recentOutbound.get(id);
			},
		});

		currentSocket = socket;

		socket.ev.on("creds.update", saveCreds);

		socket.ev.on("groups.upsert", (groups) => {
			for (const group of groups) {
				cacheGroupMetadata(group);
			}
		});

		socket.ev.on("groups.update", (updates) => {
			for (const update of updates) {
				if (!update.id) continue;
				const current = groupCache.get(update.id);
				if (current) {
					groupCache.set(update.id, { ...current, ...update });
				}
			}
		});

		socket.ev.on("group-participants.update", (event) => {
			void socket
				.groupMetadata(event.id)
				.then(cacheGroupMetadata)
				.catch((err) => {
					logger.warn({ jid: event.id, err }, "Failed to refresh group metadata after participant update");
				});
		});

		socket.ev.on("connection.update", (update) => {
			const { connection, lastDisconnect, qr } = update;

			if (qr) {
				qrcode.generate(qr, { small: true });
			}

			if (connection === "open") {
				connectedAt = Math.floor(Date.now() / 1000);
				retryCount = 0;
				logger.info("Connected to WhatsApp!");

				void socket
					.groupFetchAllParticipating()
					.then((groups) => {
						for (const metadata of Object.values(groups)) {
							cacheGroupMetadata(metadata);
						}
						logger.info({ groupCount: Object.keys(groups).length }, "Cached participating group metadata");
					})
					.catch((err) => {
						logger.warn(err, "Failed to prefetch participating groups");
					});

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
				if (msg.key.fromMe) {
					rememberOutboundMessage(msg.key, msg.message);
				}

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
		onVideoMessage: (cb) => {
			onVideo = cb;
		},
		shutdown: () => {
			shuttingDown = true;
			currentSocket?.end(undefined);
		},
	};
}
