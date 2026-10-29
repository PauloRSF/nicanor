import type { WAMessage, WASocket } from "baileys";

import { type CommandParams, CommandRouter } from "../_lib/command-router.js";
import { logger } from "../_lib/logger.js";
import { createWhatsAppClient } from "../_lib/whatsapp/client.js";
import { downloadSocialMediaCommand, socialMediaToSticker } from "../social/commands.js";
import { extractSocialUrl } from "../social/detect.js";
import {
	deleteSticker,
	saveGifAsSticker,
	saveImageAsSticker,
	saveSticker,
	saveVideoToSticker,
	searchStickers,
	sendRawLastSticker,
	tagSticker,
} from "../sticker/commands.js";
import { isStickerTaggingEnabled, toggleStickerTagging } from "../user-settings/index.js";
import type { Context } from "./types.js";

const TAGGING_DISABLED_REPLY = "A marcação de tags está desativada. Use *!habilitartags* para ativá-la.";
const TAGGING_COMMANDS = new Set(["!tag", "!t", "!search", "!s"]);

function buildContext(socket: WASocket, jid: string, isGroup: boolean, sourceMessage: WAMessage): Context {
	const enrichedLogger = logger.child({ jid });
	const quotedOptions = isGroup
		? {
				quoted: {
					key: {
						remoteJid: sourceMessage.key.remoteJid,
						id: sourceMessage.key.id,
						fromMe: sourceMessage.key.fromMe,
						participant: sourceMessage.key.participant,
					},
					message: sourceMessage.message,
				},
			}
		: undefined;

	async function send(
		content: Parameters<WASocket["sendMessage"]>[1],
		logFields: Record<string, unknown>,
		logMsg: string,
	): Promise<void> {
		enrichedLogger.info({ ...logFields, isGroup }, logMsg);

		try {
			await socket.sendMessage(jid, content, quotedOptions);
		} catch (error) {
			if (!quotedOptions) throw error;

			enrichedLogger.warn({ err: error }, "Quoted group send failed, retrying without quote");
			await socket.sendMessage(jid, content);
		}
	}

	return {
		userId: jid,
		logger: enrichedLogger,
		isGroup,
		sendText: async (text: string) => {
			await send({ text }, { text }, "Sending text");
		},
		sendSticker: async (bytes: Buffer) => {
			await send({ sticker: bytes }, { stickerByteLength: bytes.length }, "Sending sticker");
		},
		sendImage: async (bytes: Buffer) => {
			await send({ image: bytes }, { imageByteLength: bytes.length }, "Sending image");
		},
		sendGif: async (bytes: Buffer) => {
			await send({ video: bytes, gifPlayback: true }, { gifByteLength: bytes.length }, "Sending gif playback");
		},
		sendVideo: async (bytes: Buffer) => {
			await send({ video: bytes, mimetype: "video/mp4" }, { videoByteLength: bytes.length }, "Sending video");
		},
	};
}

function requireStickerTagging(
	handler: (context: CommandParams<Context>) => Promise<void>,
): (context: CommandParams<Context>) => Promise<void> {
	return async (context) => {
		if (!(await isStickerTaggingEnabled(context.userId))) {
			return await context.sendText(TAGGING_DISABLED_REPLY);
		}

		return await handler(context);
	};
}

async function toggleTaggingCommand({ userId, sendText }: CommandParams<Context>): Promise<void> {
	const enabled = await toggleStickerTagging(userId);

	if (enabled) {
		return await sendText("Marcação de tags ativada. Use *!tag* para marcar e *!search* para buscar.");
	}

	return await sendText("Marcação de tags desativada.");
}

function startsWithCommand(text: string): boolean {
	return text.trimStart().startsWith("!");
}

let shutdownFn: (() => void) | null = null;

export function shutdown(): void {
	shutdownFn?.();
	shutdownFn = null;
}

export async function init(): Promise<void> {
	const client = await createWhatsAppClient();
	shutdownFn = () => {
		client.shutdown();
	};

	const commandRouter = CommandRouter<Context>();

	commandRouter.command({
		command: ["<default>"],
		help: "Mostra esta mensagem",
		handler: ({ sendText }) =>
			sendText(
				"Envie somente mídias (imagens, vídeos ou GIFs) para que eu transforme em figurinha.\n\nEnvie *!h* para ver a lista dos comandos que eu posso executar.",
			),
	});

	commandRouter.command({
		command: ["!help", "!h"],
		help: "Mostra esta mensagem",
		handler: async ({ userId, sendText }) => {
			const taggingEnabled = await isStickerTaggingEnabled(userId);
			const intro =
				"Oi, eu sou o Nicanor 🤖!\n\nVocê pode me enviar images, vídeos ou GIFs e eu vou transformá-los em figurinha. Em grupos, você pode me marcar (@) em mensagem com mídias.\n\nMeus comandos são:\n\n";

			const help = commandRouter.helpText((cmd) => {
				if (!taggingEnabled && cmd.command.some((alias) => TAGGING_COMMANDS.has(alias))) {
					return false;
				}

				return true;
			});

			await sendText(`${intro}${help}`);
		},
	});

	commandRouter.command({
		command: ["!figurinha", "!f", "!x", "!twitter"],
		help: "Converte uma mídia do X/Twitter, TikTok ou Instagram em figurinha (informe o link)",
		handler: socialMediaToSticker,
	});

	commandRouter.command({
		command: ["!baixar", "!b"],
		help: "Baixa uma mídia do X/Twitter, TikTok ou Instagram (informe o link)",
		handler: downloadSocialMediaCommand,
	});

	commandRouter.command({
		command: ["!raw", "!r"],
		help: "Envia o arquivo da última figurinha",
		handler: sendRawLastSticker,
	});

	commandRouter.command({
		command: ["!habilitartags"],
		help: "Ativa ou desativa a marcação de figurinhas com tags",
		handler: toggleTaggingCommand,
	});

	commandRouter.command({
		command: ["!tag", "!t"],
		help: "Marca a última figurinha com tags",
		handler: requireStickerTagging(tagSticker),
	});

	commandRouter.command({
		command: ["!search", "!s"],
		help: "Busca figurinhas por tags",
		handler: requireStickerTagging(searchStickers),
	});

	commandRouter.command({
		command: ["!delete", "!d"],
		help: "Apaga a última figurinha",
		handler: deleteSticker,
	});

	client.onTextMessage(async ({ jid, socket, text, isGroup, sourceMessage }) => {
		const context = buildContext(socket, jid, isGroup, sourceMessage);

		context.logger.child({ class: "message-events" }).info({ text, isGroup }, "Received text message");

		try {
			if (!startsWithCommand(text)) {
				const socialUrl = extractSocialUrl(text);

				if (socialUrl) {
					await socialMediaToSticker({ ...context, args: [socialUrl] });
					return;
				}
			}

			// Commands (and the default help reply) are DM-only.
			if (isGroup) {
				return;
			}

			await commandRouter.handle(context, text);
		} catch (error) {
			logger.error(error, "Error processing text message");
			if (isGroup) {
				await context.sendText("Não consegui processar essa mensagem.");
			}
		}
	});

	client.onStickerMessage(async ({ jid, socket, stickerBytes, isGroup, sourceMessage }) => {
		const context = buildContext(socket, jid, isGroup, sourceMessage);

		context.logger
			.child({ class: "message-events" })
			.info({ stickerByteLength: stickerBytes.length }, "Received sticker message");

		try {
			await saveSticker({ ...context, sticker: stickerBytes });
		} catch (error) {
			logger.error(error, "Error processing sticker message");
		}
	});

	client.onImageMessage(async ({ jid, socket, imageBytes, isGroup, sourceMessage }) => {
		const context = buildContext(socket, jid, isGroup, sourceMessage);

		context.logger
			.child({ class: "message-events" })
			.info({ imageByteLength: imageBytes.length, isGroup }, "Received image message");

		try {
			await saveImageAsSticker({ ...context, image: imageBytes });
		} catch (error) {
			logger.error(error, "Error processing image message");
			if (isGroup) {
				await context.sendText("Não consegui converter esta imagem para figurinha.");
			}
		}
	});

	client.onGifMessage(async ({ jid, socket, gifBytes, gifInputExt, isGroup, sourceMessage }) => {
		const context = buildContext(socket, jid, isGroup, sourceMessage);

		context.logger
			.child({ class: "message-events" })
			.info(
				{ gifByteLength: gifBytes.length, gifInputExt, isGroup },
				gifInputExt === "gif" ? "Received gif document message" : "Received gif playback message",
			);

		try {
			await saveGifAsSticker({ ...context, gif: gifBytes, gifInputExt });
		} catch (error) {
			logger.error(error, "Error processing gif message");
			await context.sendText("Não consegui converter este GIF para figurinha.");
		}
	});

	client.onVideoMessage(async ({ jid, socket, videoBytes, isGroup, sourceMessage }) => {
		const context = buildContext(socket, jid, isGroup, sourceMessage);

		context.logger
			.child({ class: "message-events" })
			.info({ videoByteLength: videoBytes.length, isGroup }, "Received video message");

		try {
			await saveVideoToSticker({ ...context, video: videoBytes });
		} catch (error) {
			logger.error(error, "Error processing video message");
			await context.sendText("Não consegui converter este vídeo para figurinha.");
		}
	});
}
