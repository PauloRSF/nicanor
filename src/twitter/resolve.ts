const TWITTER_STATUS_URL =
	/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)(?:\/(?:photo|video)\/(\d+))?/i;

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

export class TwitterResolveError extends Error {
	constructor(
		message: string,
		readonly userMessage: string,
	) {
		super(message);
		this.name = "TwitterResolveError";
	}
}

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

function selectMedia(all: TwitterMedia[], mediaIndex?: number): TwitterMedia {
	if (mediaIndex !== undefined) {
		const media = all[mediaIndex];
		if (!media) {
			throw new TwitterResolveError(
				`Media index ${mediaIndex} out of range`,
				"Não encontrei a mídia indicada nesse post.",
			);
		}
		return media;
	}

	const gifs = all.filter((item) => item.type === "gif");

	if (gifs.length === 1) {
		return gifs[0];
	}

	if (gifs.length === 0) {
		throw new TwitterResolveError("No GIF in tweet", "Esse link não é de um GIF.");
	}

	throw new TwitterResolveError(
		"Multiple GIFs without media index",
		"Esse post tem mais de um GIF. Informe o link com /photo/N ou /video/N.",
	);
}

export async function resolveTwitterGif(url: string): Promise<{ mp4Url: string }> {
	const parsed = parseTwitterUrl(url);
	if (!parsed) {
		throw new TwitterResolveError("Invalid Twitter URL", "Link inválido. Use um link de post do X/Twitter.");
	}

	const apiUrl = `https://api.fxtwitter.com/status/${parsed.tweetId}`;
	const response = await fetch(apiUrl, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!response.ok) {
		throw new TwitterResolveError(`FxTwitter HTTP ${response.status}`, "Não consegui acessar esse post.");
	}

	const data = (await response.json()) as FxTwitterResponse;

	if (data.code !== 200 || !data.tweet) {
		const message = data.message ?? "Unknown error";
		if (message === "NOT_FOUND" || message === "PRIVATE_TWEET" || message === "API_FAIL") {
			throw new TwitterResolveError(message, "Não consegui acessar esse post.");
		}
		throw new TwitterResolveError(message, "Não consegui acessar esse post.");
	}

	const all = data.tweet.media?.all;
	if (!all || all.length === 0) {
		throw new TwitterResolveError("No media in tweet", "Esse link não é de um GIF.");
	}

	const media = selectMedia(all, parsed.mediaIndex);

	if (media.type !== "gif") {
		throw new TwitterResolveError(`Media type is ${media.type}`, "Esse link não é de um GIF.");
	}

	return { mp4Url: media.url };
}
