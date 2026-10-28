import type { CommandParams } from "../_lib/command-router.js";
import { gifToSticker, imageToSticker, isAnimatedSticker, stickerToGifPlayback } from "../_lib/whatsapp/media.js";
import type { Context } from "../messages/types.js";
import { isStickerTaggingEnabled } from "../user-settings/index.js";
import { Sticker, UnsavedSticker } from "./index.js";

const TAG_PROMPT = "Use *!tag (ou !t) tag1 tag2 ...* para marcá-la.";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

type SaveStickerParams = WithRequired<Omit<CommandParams<Context>, "args">, "sticker">;

export async function saveSticker({
	userId,
	logger,
	sticker: stickerBytes,
	sendText,
}: SaveStickerParams): Promise<void> {
	const sticker = await new UnsavedSticker({
		userId,
		data: stickerBytes,
	}).save();

	logger.info({ stickerId: sticker.id }, "Sticker saved");

	const taggingEnabled = await isStickerTaggingEnabled(userId);

	if (!taggingEnabled) {
		await sendText("Figurinha recebida!");
		return;
	}

	const existingTagsMessage = sticker.tags.length > 0 ? `\n\nTags atuais: ${sticker.tags.join(", ")}` : "";

	await sendText(`Figurinha recebida!${existingTagsMessage}\n\n${TAG_PROMPT}`);
}

type SaveImageAsStickerParams = WithRequired<Omit<CommandParams<Context>, "args">, "image">;

export async function saveImageAsSticker({
	userId,
	logger,
	image: imageBytes,
	sendText,
	sendSticker,
}: SaveImageAsStickerParams): Promise<void> {
	const stickerBytes = await imageToSticker(imageBytes);

	const sticker = await new UnsavedSticker({
		userId,
		data: stickerBytes,
	}).save();

	logger.info({ stickerId: sticker.id }, "Sticker saved");

	const taggingEnabled = await isStickerTaggingEnabled(userId);
	const existingTagsMessage =
		taggingEnabled && sticker.tags.length > 0 ? `\n\nTags atuais: ${sticker.tags.join(", ")}` : "";

	await sendText(`Imagem recebida e convertida para figurinha!${existingTagsMessage}`);
	await sendSticker(stickerBytes);

	if (taggingEnabled) {
		await sendText(TAG_PROMPT);
	}
}

type SaveGifAsStickerParams = WithRequired<
	Omit<CommandParams<Context>, "args"> & { gifInputExt?: "mp4" | "gif" },
	"gif"
>;

export async function saveGifAsSticker({
	userId,
	logger,
	gif,
	gifInputExt = "mp4",
	sendText,
	sendSticker,
}: SaveGifAsStickerParams): Promise<void> {
	await sendText("Mídia recebida, vou converter para figurinha... Isso pode levar alguns segundos.");

	const stickerBytes = await gifToSticker(userId, gif, gifInputExt);

	const sticker = await new UnsavedSticker({
		userId,
		data: stickerBytes,
	}).save();

	logger.info({ stickerId: sticker.id }, "Sticker saved");

	const taggingEnabled = await isStickerTaggingEnabled(userId);
	const existingTagsMessage =
		taggingEnabled && sticker.tags.length > 0 ? `\n\nTags atuais: ${sticker.tags.join(", ")}` : "";

	await sendText(`Mídia convertida para figurinha!${existingTagsMessage}`);
	await sendSticker(stickerBytes);

	if (taggingEnabled) {
		await sendText(TAG_PROMPT);
	}
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
			if (!(await sticker.hasFile())) {
				logger.warn({ stickerId: sticker.id }, "Sticker file missing in storage, skipping");
				continue;
			}

			const bytes = await sticker.getFile();

			if (bytes.length === 0) {
				logger.warn({ stickerId: sticker.id }, "Sticker file is empty, skipping");
				continue;
			}

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

	const taggingEnabled = await isStickerTaggingEnabled(userId);

	return await sendText(taggingEnabled ? "A figurinha e suas tags foram apagadas." : "A figurinha foi apagada.");
}

export async function sendRawLastSticker({
	userId,
	logger,
	sendText,
	sendImage,
	sendGif,
}: CommandParams<Context>): Promise<void> {
	await sendText("Enviando arquivo da figurinha...");

	const sticker = await Sticker.getLastByUserId(userId);

	if (!sticker) {
		return await sendText("Nenhuma figurinha encontrada. Envie uma figurinha primeiro.");
	}

	if (!(await sticker.hasFile())) {
		return await sendText("Arquivo da figurinha não encontrado.");
	}

	const bytes = await sticker.getFile();

	if (bytes.length === 0) {
		return await sendText("Arquivo da figurinha não encontrado.");
	}

	if (await isAnimatedSticker(bytes)) {
		logger.info({ stickerId: sticker.id, stickerByteLength: bytes.length }, "Sending raw animated sticker as gif");

		try {
			const gifBytes = await stickerToGifPlayback(bytes);
			await sendGif(gifBytes);
		} catch (error) {
			logger.error(error, "Failed to convert or send animated sticker as gif playback");
			return await sendText("Não consegui enviar esta figurinha animada como GIF.");
		}
	} else {
		logger.info({ stickerId: sticker.id, stickerByteLength: bytes.length }, "Sending raw sticker image");

		await sendImage(bytes);
	}
}

type SaveVideoToStickerParams = WithRequired<Omit<CommandParams<Context>, "args">, "video">;

const ONE_MB_IN_BYTES = 1024 * 1024;

export async function saveVideoToSticker(context: SaveVideoToStickerParams): Promise<void> {
	const { logger, video: videoBytes, sendText } = context;

	if (videoBytes.length > 0 && videoBytes.length <= ONE_MB_IN_BYTES * 5) {
		logger.warn({ videoByteLength: videoBytes.length }, "Video too large for animated sticker conversion");

		await sendText("Esse vídeo é grande demais para virar figurinha animada (máximo de 5MB).");

		return;
	}

	await saveGifAsSticker({ ...context, gif: videoBytes, gifInputExt: "mp4" });
}
