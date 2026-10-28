import { fetchUrlToBuffer } from "../_lib/fetch-url.js";
import type { Logger } from "../_lib/logger.js";
import { detectPlatform, type SocialPlatform } from "./detect.js";
import { DownloadFailedError, SocialDownloadError, UnsupportedUrlError } from "./errors.js";
import { parseInstagramUrl, resolveInstagramMedia } from "./providers/instagram.js";
import { resolveTikTokMedia } from "./providers/tiktok.js";
import { resolveTwitterMedia } from "./providers/twitter.js";
import { downloadWithYtDlp } from "./providers/yt-dlp.js";

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export type SocialDownloadSource = "third-party" | "yt-dlp";

export type SocialMediaType = "video" | "image";

export type SocialDownloadResult = {
	bytes: Buffer;
	platform: SocialPlatform;
	source: SocialDownloadSource;
	mediaType: SocialMediaType;
};

type ResolveResult = { mediaUrl: string; mediaType: SocialMediaType };

async function resolveThirdParty(platform: SocialPlatform, url: string): Promise<ResolveResult> {
	switch (platform) {
		case "twitter": {
			const resolved = await resolveTwitterMedia(url);
			return { mediaUrl: resolved.mediaUrl, mediaType: resolved.mediaType };
		}
		case "tiktok": {
			const resolved = await resolveTikTokMedia(url);
			return { mediaUrl: resolved.mediaUrl, mediaType: resolved.mediaType };
		}
		case "instagram": {
			const resolved = await resolveInstagramMedia(url);
			return { mediaUrl: resolved.mediaUrl, mediaType: resolved.mediaType };
		}
	}
}

function playlistItemFor(platform: SocialPlatform, url: string): number | undefined {
	if (platform !== "instagram") {
		return undefined;
	}

	return parseInstagramUrl(url)?.imgIndex;
}

export async function downloadSocialMedia(url: string, logger: Logger): Promise<SocialDownloadResult> {
	const platform = detectPlatform(url);

	if (!platform) {
		throw new UnsupportedUrlError();
	}

	const playlistItem = playlistItemFor(platform, url);
	const log = logger.child({ class: "social-download", platform, url, playlistItem });

	const skipThirdParty = platform === "instagram" && playlistItem !== undefined && playlistItem > 1;

	if (!skipThirdParty) {
		try {
			const { mediaUrl, mediaType } = await resolveThirdParty(platform, url);
			const bytes = await fetchUrlToBuffer(mediaUrl, MAX_MEDIA_BYTES);
			log.info({ source: "third-party", mediaType, byteLength: bytes.length }, "Downloaded social media");
			return { bytes, platform, source: "third-party", mediaType };
		} catch (thirdPartyError) {
			log.warn(thirdPartyError, "Third-party social download failed, falling back to yt-dlp");

			try {
				const { bytes, mediaType } = await downloadWithYtDlp({
					url,
					platform,
					maxBytes: MAX_MEDIA_BYTES,
					playlistItem,
				});
				log.info({ source: "yt-dlp", mediaType, byteLength: bytes.length }, "Downloaded social media");
				return { bytes, platform, source: "yt-dlp", mediaType };
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

	try {
		const { bytes, mediaType } = await downloadWithYtDlp({
			url,
			platform,
			maxBytes: MAX_MEDIA_BYTES,
			playlistItem,
		});
		log.info({ source: "yt-dlp", mediaType, byteLength: bytes.length }, "Downloaded social media");
		return { bytes, platform, source: "yt-dlp", mediaType };
	} catch (ytDlpError) {
		log.error(ytDlpError, "yt-dlp social download failed");

		if (ytDlpError instanceof SocialDownloadError) {
			throw ytDlpError;
		}

		throw new DownloadFailedError("All download methods failed");
	}
}
