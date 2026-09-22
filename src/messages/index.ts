import type { WASocket } from "baileys";

import { type CommandParams, CommandRouter } from "../_lib/command-router.js";
import { logger } from "../_lib/logger.js";
import { createWhatsAppClient } from "../_lib/whatsapp/client.js";
import {
	deleteSticker,
	importTwitterGif,
	saveGifAsSticker,
	saveImageAsSticker,
	saveSticker,
	searchStickers,
	sendRawLastSticker,
	tagSticker,
} from "../sticker/commands.js";
import { isStickerTaggingEnabled, toggleStickerTagging } from "../user-settings/index.js";
import type { Context } from "./types.js";

const TAGGING_DISABLED_REPLY = "A marcação de tags está desativada. Use *!habilitartags* para ativá-la.";
const TAGGING_COMMANDS = new Set(["!tag", "!t", "!search", "!s"]);

function buildContext(socket: WASocket, jid: string) {
	const enrichedLogger = logger.child({ jid });

	return {
		userId: jid,
		logger: enrichedLogger,
		sendText: async (text: string) => {
			enrichedLogger.info({ text }, "Sending text");

			await socket.sendMessage(jid, { text });
		},
		sendSticker: async (bytes: Buffer) => {
			enrichedLogger.info({ stickerByteLength: bytes.length }, "Sending sticker");

			await socket.sendMessage(jid, { sticker: bytes });
		},
		sendImage: async (bytes: Buffer) => {
			enrichedLogger.info({ imageByteLength: bytes.length }, "Sending image");

			await socket.sendMessage(jid, { image: bytes });
		},
		sendGif: async (bytes: Buffer) => {
			enrichedLogger.info({ gifByteLength: bytes.length }, "Sending gif playback");

			await socket.sendMessage(jid, { video: bytes, gifPlayback: true });
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
			sendText("Não entendi... 🤔\n\nUse *!help* (ou *!h*) para ver a lista de comandos possíveis."),
	});

	commandRouter.command({
		command: ["!help", "!h"],
		help: "Mostra esta mensagem",
		handler: async ({ userId, sendText }) => {
			const taggingEnabled = await isStickerTaggingEnabled(userId);
			const intro = taggingEnabled
				? "Oi, eu sou o Nicanor 🤖!\n\nVocê pode me enviar figurinhas, GIFs (reprodução no WhatsApp ou arquivo .gif), ou imagens para marcá-las com tags.\n\nMeus comandos são:\n\n"
				: "Oi, eu sou o Nicanor 🤖!\n\nVocê pode me enviar figurinhas, GIFs (reprodução no WhatsApp ou arquivo .gif), ou imagens.\n\nMeus comandos são:\n\n";

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

	commandRouter.command({
		command: ["!raw", "!r"],
		help: "Envia o arquivo da última figurinha",
		handler: sendRawLastSticker,
	});

	commandRouter.command({
		command: ["!x", "!twitter"],
		help: "Converte um GIF do X/Twitter em figurinha (informe o link)",
		handler: importTwitterGif,
	});

	client.onTextMessage(async ({ jid, socket, text }) => {
		const context = buildContext(socket, jid);

		context.logger.child({ class: "message-events" }).info({ text }, "Received text message");

		try {
			await commandRouter.handle(context, text);
		} catch (error) {
			logger.error(error, "Error processing text message");
		}
	});

	client.onStickerMessage(async ({ jid, socket, stickerBytes }) => {
		const context = buildContext(socket, jid);

		context.logger
			.child({ class: "message-events" })
			.info({ stickerByteLength: stickerBytes.length }, "Received sticker message");

		try {
			await saveSticker({ ...context, sticker: stickerBytes });
		} catch (error) {
			logger.error(error, "Error processing sticker message");
		}
	});

	client.onImageMessage(async ({ jid, socket, imageBytes }) => {
		const context = buildContext(socket, jid);

		context.logger
			.child({ class: "message-events" })
			.info({ imageByteLength: imageBytes.length }, "Received image message");

		try {
			await saveImageAsSticker({ ...context, image: imageBytes });
		} catch (error) {
			logger.error(error, "Error processing image message");
		}
	});

	client.onGifMessage(async ({ jid, socket, gifBytes, gifInputExt }) => {
		const context = buildContext(socket, jid);

		context.logger
			.child({ class: "message-events" })
			.info(
				{ gifByteLength: gifBytes.length, gifInputExt },
				gifInputExt === "gif" ? "Received gif document message" : "Received gif playback message",
			);

		try {
			await saveGifAsSticker({ ...context, gif: gifBytes, gifInputExt });
		} catch (error) {
			logger.error(error, "Error processing gif message");
			await context.sendText("Não consegui converter este GIF para figurinha.");
		}
	});
}
