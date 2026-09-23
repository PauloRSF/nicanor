export type SocialPlatform = "twitter" | "tiktok" | "instagram";

const TWITTER_HOSTS = new Set([
	"x.com",
	"twitter.com",
	"mobile.twitter.com",
	"fxtwitter.com",
	"vxtwitter.com",
	"fixupx.com",
]);

const TIKTOK_HOST_SUFFIXES = ["tiktok.com"];

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "instagr.am", "www.instagr.am"]);

function normalizeHost(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, "");
}

function isTikTokHost(host: string): boolean {
	const normalized = normalizeHost(host);
	return TIKTOK_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function isInstagramPath(pathname: string): boolean {
	return /^\/(p|reel|reels|tv)\//i.test(pathname);
}

export function detectPlatform(url: string): SocialPlatform | null {
	let parsed: URL;

	try {
		parsed = new URL(url.includes("://") ? url : `https://${url}`);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	const normalized = normalizeHost(host);

	if (TWITTER_HOSTS.has(normalized) || TWITTER_HOSTS.has(host)) {
		return "twitter";
	}

	if (isTikTokHost(host)) {
		return "tiktok";
	}

	if (INSTAGRAM_HOSTS.has(normalized) || INSTAGRAM_HOSTS.has(host)) {
		if (isInstagramPath(parsed.pathname) || normalized === "instagr.am") {
			return "instagram";
		}
		return null;
	}

	return null;
}
