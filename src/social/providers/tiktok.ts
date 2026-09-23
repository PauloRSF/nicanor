import { AccessFailedError, NoWatermarkFreeVideoError } from "../errors.js";

const USER_AGENT = "Nicanor/0.1.0";

type TikwmResponse = {
	code?: number;
	msg?: string;
	data?: {
		hdplay?: string;
		play?: string;
		wmplay?: string;
	};
};

export async function resolveTikTokVideo(url: string): Promise<{ mp4Url: string }> {
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

	if (!mp4Url) {
		throw new NoWatermarkFreeVideoError();
	}

	return { mp4Url };
}
