const DEFAULT_TIMEOUT_MS = 30_000;
const USER_AGENT = "Nicanor/0.1.0";

export async function fetchUrlToBuffer(url: string, maxBytes: number): Promise<Buffer> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT },
			redirect: "follow",
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		if (!response.body) {
			throw new Error("Empty response body");
		}

		const chunks: Buffer[] = [];
		let totalBytes = 0;

		for await (const chunk of response.body) {
			const buffer = Buffer.from(chunk);
			totalBytes += buffer.length;

			if (totalBytes > maxBytes) {
				throw new Error(`Response exceeds ${maxBytes} bytes`);
			}

			chunks.push(buffer);
		}

		return Buffer.concat(chunks);
	} finally {
		clearTimeout(timeout);
	}
}
