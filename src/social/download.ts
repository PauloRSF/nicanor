import { fetchUrlToBuffer } from "../_lib/fetch-url.js";
import type { Logger } from "../_lib/logger.js";
import { detectPlatform, type SocialPlatform } from "./detect.js";
import { DownloadFailedError, SocialDownloadError, UnsupportedUrlError } from "./errors.js";
import { resolveInstagramVideo } from "./providers/instagram.js";
import { resolveTikTokVideo } from "./providers/tiktok.js";
import { resolveTwitterVideo } from "./providers/twitter.js";
import { downloadWithYtDlp } from "./providers/yt-dlp.js";

export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

export type SocialDownloadSource = "third-party" | "yt-dlp";

export type SocialDownloadResult = {
	bytes: Buffer;
	platform: SocialPlatform;
	source: SocialDownloadSource;
};

type ResolveResult = { mp4Url: string };

async function resolveThirdParty(platform: SocialPlatform, url: string): Promise<ResolveResult> {
	switch (platform) {
		case "twitter":
			return resolveTwitterVideo(url);
		case "tiktok":
			return resolveTikTokVideo(url);
		case "instagram":
			return resolveInstagramVideo(url);
	}
}

export async function downloadSocialVideo(url: string, logger: Logger): Promise<SocialDownloadResult> {
	const platform = detectPlatform(url);

	if (!platform) {
		throw new UnsupportedUrlError();
	}

	const log = logger.child({ class: "social-download", platform, url });

	try {
		const { mp4Url } = await resolveThirdParty(platform, url);
		const bytes = await fetchUrlToBuffer(mp4Url, MAX_VIDEO_BYTES);
		log.info({ source: "third-party", byteLength: bytes.length }, "Downloaded social video");
		return { bytes, platform, source: "third-party" };
	} catch (thirdPartyError) {
		log.warn(thirdPartyError, "Third-party social download failed, falling back to yt-dlp");

		try {
			const bytes = await downloadWithYtDlp({ url, platform, maxBytes: MAX_VIDEO_BYTES });
			log.info({ source: "yt-dlp", byteLength: bytes.length }, "Downloaded social video");
			return { bytes, platform, source: "yt-dlp" };
		} catch (ytDlpError) {
			log.error(ytDlpError, "yt-dlp social download failed");

			if (thirdPartyError instanceof SocialDownloadError) {
				throw thirdPartyError;
			}

			if (ytDlpError instanceof SocialDownloadError) {
				throw ytDlpError;
			}

			throw new DownloadFailedError("All download methods failed");
		}
	}
}
