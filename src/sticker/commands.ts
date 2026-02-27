import type { CommandParams } from "../_lib/command-router.js";
import type { Context } from "../messages/types.js";
import { Sticker, UnsavedSticker } from "./index.js";

export async function saveSticker({
	userId,
	logger,
	sticker: stickerBytes,
	sendText,
}: Omit<CommandParams<Context>, "args">): Promise<void> {
	if (!stickerBytes) {
		return await sendText("Nenhuma figurinha encontrada. Envie uma figurinha primeiro.");
	}

	const sticker = await new UnsavedSticker({ userId, data: stickerBytes }).save();

	logger.info({ stickerId: sticker.id }, "Sticker saved");

  const existingTagsMessage = sticker.tags.length > 0 ? `\n\nTags atuais: ${sticker.tags.join(", ")}` : "";

	await sendText(`Figurinha recebida!${existingTagsMessage}\n\nUse *!tag (ou !t) tag1 tag2 ...* para marcá-la.`);
}

export async function tagSticker({ args, logger, userId, sendText }: CommandParams<Context>): Promise<void> {
	if (args.length === 0) {
		return await sendText("Informe pelo menos uma tag.");
	}

	const sticker = await Sticker.getLastByUserId(userId);

	if (!sticker) {
		return await sendText("Nenhuma figurinha encontrada. Envie uma figurinha primeiro.");
	}

	logger.info({ stickerId: sticker.id, tags: args }, "Tagging sticker");

	sticker.tags = args;
	await sticker.save();

	return await sendText(`Figurinha marcada com: ${args.join(", ")}`);
}

export async function searchStickers({
	args,
	userId,
	logger,
	sendText,
	sendSticker,
}: CommandParams<Context>): Promise<void> {
	if (args.length === 0) {
		return await sendText("Informe pelo menos uma tag para buscar.");
	}

	const results = await Sticker.searchByTags(userId, args);

	if (results.length === 0) {
		return await sendText(`Nenhuma figurinha encontrada para as tags "${args.join(", ")}"`);
	}

	await sendText(`${results.length} figurinha(s) encontrada(s) para as tags "${args.join(", ")}"`);

	for (const sticker of results) {
		try {
			const bytes = await sticker.getFile();

			logger.info({ stickerId: sticker.id, stickerByteLength: bytes.length }, "Sending sticker");

			await sendSticker(bytes);
		} catch (err) {
			logger.error(err, `Failed to send sticker: ${sticker.id}`);
		}
	}
}

export async function deleteSticker({ userId, logger, sendText }: CommandParams<Context>): Promise<void> {
	const sticker = await Sticker.getLastByUserId(userId);

	if (!sticker) {
		return await sendText("Nenhuma figurinha encontrada para apagar.");
	}

	logger.info({ stickerId: sticker.id }, "Deleting sticker");

	await sticker.delete();

	return await sendText("A figurinha e suas tags foram apagadas.");
}
