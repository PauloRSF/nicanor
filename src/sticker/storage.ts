import { supabase } from "../_lib/supabase.js";
import type { Sticker } from "./model.js";

const BUCKET = "stickers";

export const StickerStorage = {
	setup: async (): Promise<void> => {
		const { error } = await supabase.storage.createBucket(BUCKET, { public: false });

		if (error && !error.message.includes("already exists")) {
			throw new Error(`Failed to create storage bucket: ${error.message}`);
		}
	},

	save: async (hash: Sticker["hash"], data: Buffer): Promise<void> => {
		if (await StickerStorage.exists(hash)) return;

		const { error } = await supabase.storage.from(BUCKET).upload(`${hash}.webp`, data, {
			contentType: "image/webp",
		});

		if (error) throw error;
	},

	delete: async (hash: Sticker["hash"]): Promise<void> => {
		const { error } = await supabase.storage.from(BUCKET).remove([`${hash}.webp`]);

		if (error) throw error;
	},

	get: async (hash: Sticker["hash"]): Promise<Buffer> => {
		const { data, error } = await supabase.storage.from(BUCKET).download(`${hash}.webp`);

		if (error || !data) throw new Error(`Failed to download sticker ${hash}: ${error?.message}`);

		return Buffer.from(await data.arrayBuffer());
	},

	exists: async (hash: Sticker["hash"]): Promise<boolean> => {
		const { data, error } = await supabase.storage.from(BUCKET).list("", { search: `${hash}.webp`, limit: 1 });

		if (error) return false;

		return (data ?? []).some((f) => f.name === `${hash}.webp`);
	},
};
