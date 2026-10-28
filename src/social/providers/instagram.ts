import { AccessFailedError, InvalidUrlError, MediaNotFoundError } from "../errors.js";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const SHORTCODE_RE = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
const INSTAGR_AM_RE = /instagr\.am\/(?:p|reel|reels|tv)?\/?([A-Za-z0-9_-]+)/i;

export type ResolvedInstagramMedia = {
	mediaUrl: string;
	mediaType: "video" | "image";
};

export type ParsedInstagramUrl = {
	shortcode: string;
	/** 1-based carousel index from `img_index`, when present */
	imgIndex?: number;
};

export function parseInstagramUrl(url: string): ParsedInstagramUrl | null {
	const shortcode = extractShortcode(url);
	if (!shortcode) {
		return null;
	}

	let imgIndex: number | undefined;

	try {
		const parsed = new URL(url.includes("://") ? url : `https://${url}`);
		const raw = parsed.searchParams.get("img_index");
		if (raw !== null && raw !== "") {
			const value = Number.parseInt(raw, 10);
			if (!Number.isNaN(value) && value >= 1) {
				imgIndex = value;
			}
		}
	} catch {
		// ignore invalid URL query parsing; shortcode alone is still usable
	}

	return { shortcode, imgIndex };
}

function extractShortcode(url: string): string | null {
	const match = url.match(SHORTCODE_RE) ?? url.match(INSTAGR_AM_RE);
	return match?.[1] ?? null;
}

function unescapeJsonUrl(value: string): string {
	return value.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

function extractVideoUrl(html: string): string | null {
	const patterns = [
		/"video_url"\s*:\s*"([^"]+)"/,
		/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/,
		/property="og:video"\s+content="([^"]+)"/,
		/property="og:video:secure_url"\s+content="([^"]+)"/,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return unescapeJsonUrl(match[1]);
		}
	}

	return null;
}

function extractImageUrl(html: string): string | null {
	const patterns = [
		/property="og:image"\s+content="([^"]+)"/,
		/property="og:image:secure_url"\s+content="([^"]+)"/,
		/"display_url"\s*:\s*"([^"]+)"/,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return unescapeJsonUrl(match[1]);
		}
	}

	return null;
}

/**
 * Resolve Instagram media via the public embed page.
 * Embed HTML usually only exposes the first carousel item, so callers should
 * fall back to yt-dlp when `img_index` > 1.
 */
export async function resolveInstagramMedia(url: string): Promise<ResolvedInstagramMedia> {
	const parsed = parseInstagramUrl(url);
	if (!parsed) {
		throw new InvalidUrlError("instagram");
	}

	if (parsed.imgIndex !== undefined && parsed.imgIndex > 1) {
		throw new MediaNotFoundError("Instagram carousel item requires yt-dlp fallback");
	}

	const embedUrl = `https://www.instagram.com/p/${parsed.shortcode}/embed/captioned/`;
	const response = await fetch(embedUrl, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "text/html",
		},
		redirect: "follow",
	});

	if (!response.ok) {
		throw new AccessFailedError("instagram", `Instagram embed HTTP ${response.status}`);
	}

	const html = await response.text();
	const mp4Url = extractVideoUrl(html);

	if (mp4Url) {
		return { mediaUrl: mp4Url, mediaType: "video" };
	}

	const imageUrl = extractImageUrl(html);
	if (imageUrl) {
		return { mediaUrl: imageUrl, mediaType: "image" };
	}

	throw new MediaNotFoundError("No media URL in Instagram embed");
}
