import { AccessFailedError, MediaNotFoundError, NoWatermarkFreeVideoError } from "../errors.js";

const USER_AGENT = "Nicanor/0.1.0";

type TikwmResponse = {
	code?: number;
	msg?: string;
	data?: {
		hdplay?: string;
		play?: string;
		wmplay?: string;
		images?: string[];
	};
};

export type ResolvedTikTokMedia = {
	mediaUrl: string;
	mediaType: "video" | "image";
};

export async function resolveTikTokMedia(url: string): Promise<ResolvedTikTokMedia> {
	const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
	const response = await fetch(apiUrl, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!response.ok) {
		throw new AccessFailedError("tiktok", `tikwm HTTP ${response.status}`);
	}

	const data = (await response.json()) as TikwmResponse;

	if (data.code !== 0 || !data.data) {
		throw new AccessFailedError("tiktok", data.msg ?? "tikwm failed");
	}

	const mp4Url = data.data.hdplay || data.data.play;

	if (mp4Url) {
		return { mediaUrl: mp4Url, mediaType: "video" };
	}

	const images = data.data.images?.filter(Boolean) ?? [];
	if (images.length >= 1) {
		return { mediaUrl: images[0], mediaType: "image" };
	}

	if (data.data.wmplay) {
		throw new NoWatermarkFreeVideoError();
	}

	throw new MediaNotFoundError("No media in TikTok response");
}
