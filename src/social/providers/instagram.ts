import { AccessFailedError, InvalidUrlError, MediaNotFoundError } from "../errors.js";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const SHORTCODE_RE = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
const INSTAGR_AM_RE = /instagr\.am\/(?:p|reel|reels|tv)?\/?([A-Za-z0-9_-]+)/i;

function extractShortcode(url: string): string | null {
	const match = url.match(SHORTCODE_RE) ?? url.match(INSTAGR_AM_RE);
	return match?.[1] ?? null;
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
			return match[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
		}
	}

	return null;
}

export async function resolveInstagramVideo(url: string): Promise<{ mp4Url: string }> {
	const shortcode = extractShortcode(url);
	if (!shortcode) {
		throw new InvalidUrlError("instagram");
	}

	const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
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

	if (!mp4Url) {
		throw new MediaNotFoundError("No video_url in Instagram embed");
	}

	return { mp4Url };
}
