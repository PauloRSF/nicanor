import type { WASocket } from "baileys";
import { CommandRouter } from "../_lib/command-router.js";
import { logger } from "../_lib/logger.js";
import { createWhatsAppClient } from "../_lib/whatsapp.js";
import { deleteSticker, saveImageAsSticker, saveSticker, searchStickers, tagSticker } from "../sticker/commands.js";
import type { Context } from "./types.js";

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
	};
}

let shutdownFn: (() => void) | null = null;

export function shutdown(): void {
	shutdownFn?.();
	shutdownFn = null;
}

export async function init(): Promise<void> {
	const client = await createWhatsAppClient();
	shutdownFn = client.shutdown;

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
		handler: ({ sendText }) => sendText(`Oi, eu sou o Nicanor 🤖!\n\nVocê pode me enviar figurinhas ou imagens para marcá-las com tags.\n\nMeus comandos são:\n\n${commandRouter.helpText()}`),
	});

	commandRouter.command({
		command: ["!tag", "!t"],
		help: "Marca a última figurinha com tags",
		handler: tagSticker,
	});

	commandRouter.command({
		command: ["!search", "!s"],
		help: "Busca figurinhas por tags",
		handler: searchStickers,
	});

	commandRouter.command({
		command: ["!delete", "!d"],
		help: "Apaga a última figurinha e suas tags",
		handler: deleteSticker,
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
}
