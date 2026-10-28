import type { CommandParams } from "../_lib/command-router.js";
import type { Context } from "../messages/types.js";
import { saveGifAsSticker, saveImageAsSticker } from "../sticker/commands.js";
import { downloadSocialMedia } from "./download.js";
import {
	AccessFailedError,
	AmbiguousMediaError,
	DownloadFailedError,
	InvalidUrlError,
	MediaIndexOutOfRangeError,
	MediaNotFoundError,
	NoWatermarkFreeVideoError,
	SocialDownloadError,
	UnsupportedUrlError,
	VideoTooLargeError,
} from "./errors.js";

function socialDownloadUserMessage(error: SocialDownloadError): string {
	if (error instanceof UnsupportedUrlError) {
		return "Link não suportado. Envie um link do X/Twitter, TikTok ou Instagram.";
	}

	if (error instanceof InvalidUrlError) {
		if (error.platform === "instagram") {
			return "Link inválido. Use um link de post/reel do Instagram.";
		}
		return "Link inválido. Use um link de post do X/Twitter.";
	}

	if (error instanceof MediaIndexOutOfRangeError) {
		return "Não encontrei a mídia indicada nesse post.";
	}

	if (error instanceof AmbiguousMediaError) {
		return "Esse post tem mais de um vídeo. Informe o link com /photo/N ou /video/N.";
	}

	if (error instanceof MediaNotFoundError) {
		return "Esse link não tem mídia que eu consiga baixar.";
	}

	if (error instanceof AccessFailedError) {
		if (error.platform === "tiktok") {
			return "Não consegui acessar esse TikTok.";
		}
		if (error.platform === "instagram") {
			return "Não consegui acessar esse Instagram.";
		}
		return "Não consegui acessar esse post.";
	}

	if (error instanceof NoWatermarkFreeVideoError) {
		return "Não encontrei o vídeo sem marca d'água.";
	}

	if (error instanceof VideoTooLargeError) {
		return "A mídia é grande demais para eu enviar.";
	}

	if (error instanceof DownloadFailedError) {
		return "Não consegui baixar a mídia.";
	}

	return "Não consegui baixar a mídia.";
}

export async function downloadSocialMediaCommand({
	args,
	logger,
	sendText,
	sendVideo,
	sendImage,
}: CommandParams<Context>): Promise<void> {
	const url = args[0];

	if (!url) {
		return await sendText("Informe o link da mídia. Ex: *!baixar https://www.tiktok.com/...*");
	}

	await sendText("Baixando a mídia... Isso pode levar alguns segundos.");

	try {
		const { bytes, platform, source, mediaType } = await downloadSocialMedia(url, logger);
		logger.info({ platform, source, mediaType, byteLength: bytes.length }, "Sending social media");

		if (mediaType === "image") {
			await sendImage(bytes);
		} else {
			await sendVideo(bytes);
		}
	} catch (error) {
		if (error instanceof SocialDownloadError) {
			return await sendText(socialDownloadUserMessage(error));
		}

		logger.error(error, "Failed to download social media");
		await sendText("Não consegui baixar a mídia.");
	}
}

export async function socialMediaToSticker({
	args,
	userId,
	logger,
	sendText,
	sendSticker,
	sendImage,
	sendGif,
	sendVideo,
}: CommandParams<Context>): Promise<void> {
	const url = args[0];

	if (!url) {
		return await sendText("Informe o link da mídia. Ex: *!figurinha https://www.tiktok.com/...*");
	}

	try {
		const { bytes, platform, source, mediaType } = await downloadSocialMedia(url, logger);
		logger.info({ platform, source, mediaType, byteLength: bytes.length }, "Converting social media to sticker");

		if (mediaType === "image") {
			await saveImageAsSticker({
				userId,
				logger,
				image: bytes,
				sendText,
				sendSticker,
				sendImage,
				sendGif,
				sendVideo,
			});
			return;
		}

		await saveGifAsSticker({
			userId,
			logger,
			gif: bytes,
			gifInputExt: "mp4",
			sendText,
			sendSticker,
			sendImage,
			sendGif,
			sendVideo,
		});
	} catch (error) {
		if (error instanceof SocialDownloadError) {
			return await sendText(socialDownloadUserMessage(error));
		}

		logger.error(error, "Failed to convert social media to sticker");
		await sendText("Não consegui converter esta mídia para figurinha.");
	}
}
