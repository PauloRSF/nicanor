import {
	AccessFailedError,
	AmbiguousMediaError,
	InvalidUrlError,
	MediaIndexOutOfRangeError,
	MediaNotFoundError,
} from "../errors.js";

const TWITTER_STATUS_URL =
	/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|mobile\.twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)\/\w+\/status\/(\d+)(?:\/(?:photo|video)\/(\d+))?/i;

const USER_AGENT = "Nicanor/0.1.0";

type TwitterMedia = {
	type: "photo" | "video" | "gif";
	url: string;
};

type FxTwitterResponse = {
	code: number;
	message: string;
	tweet?: {
		media?: {
			all?: TwitterMedia[];
		};
	};
};

export type ResolvedTwitterMedia = {
	mediaUrl: string;
	mediaType: "video" | "image";
};

export function parseTwitterUrl(url: string): { tweetId: string; mediaIndex?: number } | null {
	const match = url.match(TWITTER_STATUS_URL);
	if (!match) return null;

	const tweetId = match[1];
	const mediaIndex = match[2] ? Number.parseInt(match[2], 10) - 1 : undefined;

	if (mediaIndex !== undefined && (Number.isNaN(mediaIndex) || mediaIndex < 0)) {
		return null;
	}

	return { tweetId, mediaIndex };
}

function mediaTypeOf(media: TwitterMedia): "video" | "image" {
	return media.type === "photo" ? "image" : "video";
}

function selectMedia(all: TwitterMedia[], mediaIndex?: number): TwitterMedia {
	if (mediaIndex !== undefined) {
		const media = all[mediaIndex];
		if (!media) {
			throw new MediaIndexOutOfRangeError(mediaIndex);
		}
		return media;
	}

	const videos = all.filter((item) => item.type === "video" || item.type === "gif");

	if (videos.length === 1) {
		return videos[0];
	}

	if (videos.length > 1) {
		throw new AmbiguousMediaError("Multiple videos without media index");
	}

	const photos = all.filter((item) => item.type === "photo");
	if (photos.length >= 1) {
		return photos[0];
	}

	throw new MediaNotFoundError("No media in tweet");
}

export async function resolveTwitterMedia(url: string): Promise<ResolvedTwitterMedia> {
	const parsed = parseTwitterUrl(url);
	if (!parsed) {
		throw new InvalidUrlError("twitter");
	}

	const apiUrl = `https://api.fxtwitter.com/status/${parsed.tweetId}`;
	const response = await fetch(apiUrl, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!response.ok) {
		throw new AccessFailedError("twitter", `FxTwitter HTTP ${response.status}`);
	}

	const data = (await response.json()) as FxTwitterResponse;

	if (data.code !== 200 || !data.tweet) {
		throw new AccessFailedError("twitter", data.message ?? "Unknown error");
	}

	const all = data.tweet.media?.all;
	if (!all || all.length === 0) {
		throw new MediaNotFoundError("No media in tweet");
	}

	const media = selectMedia(all, parsed.mediaIndex);

	return { mediaUrl: media.url, mediaType: mediaTypeOf(media) };
}
