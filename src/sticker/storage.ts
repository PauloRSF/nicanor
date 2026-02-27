import fs from "node:fs/promises";
import path from "node:path";

import type { Sticker } from "./model.js";

const STICKERS_DIR = path.resolve("stickers");

function getStickerFilePath(hash: Sticker["hash"]): string {
	return path.join(STICKERS_DIR, `${hash}.webp`);
}

export const StickerStorage = {
	setup: async (): Promise<void> => {
		await fs.mkdir(STICKERS_DIR, { recursive: true });
	},

	save: async (hash: Sticker["hash"], data: Buffer): Promise<void> => {
		const stickerFilePath = getStickerFilePath(hash);

		await fs.writeFile(stickerFilePath, data, { flag: "wx" }).catch((err) => {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		});
	},

	delete: async (hash: Sticker["hash"]): Promise<void> => {
		const stickerFilePath = getStickerFilePath(hash);

		await fs.unlink(stickerFilePath).catch((err) => {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		});
	},

	get: async (hash: Sticker["hash"]): Promise<Buffer> => {
		const stickerFilePath = getStickerFilePath(hash);

		return await fs.readFile(stickerFilePath);
	},

	exists: async (hash: Sticker["hash"]): Promise<boolean> => {
		const stickerFilePath = getStickerFilePath(hash);

		return fs.access(stickerFilePath).then(
			() => true,
			() => false,
		);
	},
};
