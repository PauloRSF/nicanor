import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import { ffmpegPath, getAnimatedWebpOptions, getGifToMp4Options } from "../_lib/ffmpeg.js";
import { logger as rootLogger } from "../_lib/logger.js";

const execFileAsync = promisify(execFile);

const STICKER_SIZE = 512;

type ConversionParams = {
	quality: number;
	size: number;
	maxFps?: number;
};

const GIF_TO_STICKER_CONVERSION_PARAMS_ATTEMPTS: ConversionParams[] = [
	{ quality: 82, size: STICKER_SIZE },
	{ quality: 76, size: STICKER_SIZE },
	{ maxFps: 18, quality: 82, size: STICKER_SIZE },
	{ maxFps: 18, quality: 76, size: 448 },
	{ maxFps: 18, quality: 60, size: 448 },
	{ maxFps: 18, quality: 60, size: 320 },
	{ maxFps: 15, quality: 50, size: 320 },
	{ maxFps: 15, quality: 40, size: 256 },
];

/** https://faq.whatsapp.com/1056840314992666 */
const MAX_ANIMATED_STICKER_BYTES = 500 * 1024;

export type ConvertAnimationJob = {
	userId: string;
	gifBytes: Buffer;
	inputExt: "mp4" | "gif";
};

export async function convertAnimationToSticker(job: ConvertAnimationJob): Promise<Buffer> {
	const logger = rootLogger.child({
		userId: job.userId,
		class: "gif-conversion",
	});

	const { userId, gifBytes, inputExt } = job;
	const filesPrefix = `${userId}-${Date.now()}`;
	const workDir = await mkdtemp(join(tmpdir(), "nicanor-gif-"));

	const inputPath = join(workDir, `${filesPrefix}-input.${inputExt}`);
	const outputPath = join(workDir, `${filesPrefix}-output.webp`);

	try {
		await writeFile(inputPath, gifBytes);

		for (const attempt of GIF_TO_STICKER_CONVERSION_PARAMS_ATTEMPTS) {
			const options = getAnimatedWebpOptions({
				inputPath,
				outputPath,
				maxFps: attempt.maxFps,
				size: attempt.size,
				quality: attempt.quality,
			});

			try {
				await execFileAsync(ffmpegPath, options, {
					maxBuffer: 10 * 1024 * 1024,
				});

				const out = await readFile(outputPath);

				if (out.length <= MAX_ANIMATED_STICKER_BYTES) {
					logger.info({ stickerByteLength: out.length }, "Animated sticker encoded successfully");
					return out;
				}

				logger.warn({ stickerByteLength: out.length }, "Animated sticker encoded successfully, but it's too large");
			} catch (error) {
				logger.error(error, "Failed to encode animated sticker (ffmpeg)");
			}
		}

		throw new Error("Failed to encode animated sticker (ffmpeg)");
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

export async function convertAnimatedStickerToGifPlayback(webpBytes: Buffer): Promise<Buffer> {
	const gifBytes = await sharp(webpBytes, { animated: true })
		.ensureAlpha()
		.flatten({ background: { r: 0, g: 0, b: 0 } })
		.gif({ loop: 0, reuse: false, interFrameMaxError: 0 })
		.toBuffer();

	const workDir = await mkdtemp(join(tmpdir(), "nicanor-gif-playback-"));
	const inputPath = join(workDir, "input.gif");
	const outputPath = join(workDir, "output.mp4");

	try {
		await writeFile(inputPath, gifBytes);

		await execFileAsync(ffmpegPath, getGifToMp4Options({ inputPath, outputPath }), {
			maxBuffer: 10 * 1024 * 1024,
		});

		return await readFile(outputPath);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
