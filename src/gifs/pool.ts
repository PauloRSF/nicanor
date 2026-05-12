import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Piscina } from "piscina";

import { logger } from "../_lib/logger.js";
import type { ConvertAnimationJob } from "./conversion.js";

function workerEntryFile(): string {
	const dir = dirname(fileURLToPath(import.meta.url));
	const local = join(dir, "worker.js");

	if (existsSync(local)) return local;

	const norm = dir.replace(/\\/g, "/");
	const match = norm.match(/^(.*)\/src\/(.+)$/);

	if (match) {
		const distPath = join(match[1], "dist", match[2], "worker.js");

		if (existsSync(distPath)) return distPath;
	}

	throw new Error("Missing GIF worker entry file (worker.js).");
}

let pool: Piscina<ConvertAnimationJob, Uint8Array> | null = null;

export async function convertGifToWebp(userId: string, gifBytes: Buffer, inputExt: "mp4" | "gif"): Promise<Buffer> {
	if (!pool) {
		throw new Error("GIF conversion worker pool not initialized");
	}

	const result = await pool.run({
		userId,
		gifBytes: Buffer.from(gifBytes),
		inputExt,
	});

	return Buffer.from(result);
}

export const gifConversionWorkerPool = {
	init: async () => {
		const poolSizeEnvVar = Number.parseInt(process.env.NICANOR_GIF_CONVERSION_WORKER_POOL_SIZE ?? "", 10);
		const poolSize = Number.isNaN(poolSizeEnvVar) ? 1 : poolSizeEnvVar;

		if (!pool) {
			pool = new Piscina({
				filename: workerEntryFile(),
				maxThreads: poolSize,
				minThreads: 0,
			});

			logger.info({ poolSize }, "GIF conversion worker pool initialized");
		}
	},
	shutdown: async () => {
		if (!pool) return;

		const p = pool;

		pool = null;

		await p.destroy();
	},
};
