import sharp from "sharp";

import { convertGifToWebp } from "../../gifs/pool.js";
import { logger } from "../logger.js";

export const STICKER_SIZE = 512;

export async function imageToSticker(imageBytes: Buffer): Promise<Buffer> {
	return sharp(imageBytes)
		.resize(STICKER_SIZE, STICKER_SIZE, {
			fit: "contain",
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.webp()
		.toBuffer();
}

export async function gifToSticker(userId: string, gifBytes: Buffer, inputExt: "mp4" | "gif" = "mp4"): Promise<Buffer> {
	logger.info({ userId, inputExt, gifByteLength: gifBytes.length }, "Queued animation sticker conversion");

	const stickerBytes = await convertGifToWebp(userId, gifBytes, inputExt);

	logger.info({ userId, inputExt, stickerByteLength: stickerBytes.length }, "Animation sticker conversion finished");

	return stickerBytes;
}
