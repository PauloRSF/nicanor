import crypto from "node:crypto";

import { supabase } from "../_lib/supabase.js";
import { StickerStorage } from "./storage.js";

const MAX_TAG_LENGTH = 64;
const MAX_SEARCH_RESULTS = 10;

type UnsavedStickerConstructorOptions = {
	userId: string;
	data: Buffer;
};

export class UnsavedSticker {
	public readonly userId: string;
	public readonly data: Buffer;
	private cachedHash: string | null = null;

	constructor(options: UnsavedStickerConstructorOptions) {
		this.userId = options.userId;
		this.data = options.data;
	}

	async save(): Promise<Sticker> {
		const hash = this.hash;

		const { data: row, error } = await supabase
			.from("stickers")
			.upsert({ hash, user_id: this.userId, last_sent_at: new Date().toISOString() }, { onConflict: "hash,user_id" })
			.select()
			.single();

		if (error || !row) {
			throw new Error(`Failed to upsert sticker: hash=${hash}, userId=${this.userId} — ${error?.message}`);
		}

		await StickerStorage.save(hash, this.data);

		const { data: tagRows } = await supabase.from("sticker_tags").select("tag").eq("sticker_id", row.id);

		return new Sticker({
			id: row.id,
			hash,
			userId: this.userId,
			tags: (tagRows ?? []).map((t) => t.tag),
		});
	}

	get hash(): string {
		if (this.cachedHash) return this.cachedHash;

		this.cachedHash = crypto.createHash("sha256").update(this.data).digest("hex");

		return this.cachedHash;
	}
}

type StickerConstructorOptions = {
	id: number;
	hash: string;
	userId: string;
	tags: string[];
};

function sanitizeTag(tag: string): string {
	return tag
		.toLowerCase()
		.trim()
		.slice(0, MAX_TAG_LENGTH)
		.replace(/[^\p{L}\p{N}_-]/gu, "");
}

export class Sticker {
	public readonly id: number;
	public readonly hash: string;
	public readonly userId: string;
	public tags: string[];
	private cachedFile: Buffer | null = null;

	constructor(options: StickerConstructorOptions) {
		this.id = options.id;
		this.hash = options.hash;
		this.userId = options.userId;
		this.tags = options.tags ?? [];
	}

	async getFile(): Promise<Buffer> {
		if (this.cachedFile) return this.cachedFile;

		this.cachedFile = await StickerStorage.get(this.hash);

		return this.cachedFile;
	}

	async hasFile(): Promise<boolean> {
		return await StickerStorage.exists(this.hash);
	}

	async save(): Promise<void> {
		await supabase.from("sticker_tags").delete().eq("sticker_id", this.id);

		const sanitized = this.tags.map(sanitizeTag).filter(Boolean);

		if (sanitized.length > 0) {
			const rows = [...new Set(sanitized)].map((tag) => ({ sticker_id: this.id, tag }));

			const { error } = await supabase.from("sticker_tags").insert(rows);

			if (error) throw new Error(`Failed to insert tags for sticker ${this.id}: ${error.message}`);
		}
	}

	async delete(): Promise<void> {
		const { hash } = this;

		await supabase.from("sticker_tags").delete().eq("sticker_id", this.id);
		await supabase.from("stickers").delete().eq("id", this.id);

		const { count } = await supabase.from("stickers").select("id", { count: "exact", head: true }).eq("hash", hash);

		if (!count || count === 0) {
			await StickerStorage.delete(hash);
		}
	}

	static async getLastByUserId(userId: string): Promise<Sticker | null> {
		const { data: row, error } = await supabase
			.from("stickers")
			.select("id, hash, user_id, sticker_tags(tag)")
			.eq("user_id", userId)
			.order("last_sent_at", { ascending: false })
			.limit(1)
			.single();

		if (error || !row) return null;

		const tags = (row.sticker_tags as { tag: string }[]).map((t) => t.tag);

		return new Sticker({ id: row.id, hash: row.hash, userId: row.user_id, tags });
	}

	static async searchByTags(userId: string, tags: string[], limit = MAX_SEARCH_RESULTS): Promise<Sticker[]> {
		const normalized = tags.map(sanitizeTag).filter(Boolean);
		if (normalized.length === 0) return [];

		const orFilter = normalized.map((t) => `tag.ilike.%${t}%`).join(",");

		const { data: rows, error } = await supabase
			.from("sticker_tags")
			.select("tag, sticker_id, stickers!inner(id, hash, user_id)")
			.eq("stickers.user_id", userId)
			.or(orFilter);

		if (error || !rows) return [];

		const stickerMap = new Map<number, { sticker: Sticker; matchedPositions: Set<number> }>();

		for (const row of rows) {
			const s = row.stickers as unknown as { id: number; hash: string; user_id: string };
			let entry = stickerMap.get(s.id);
			if (!entry) {
				entry = {
					sticker: new Sticker({ id: s.id, hash: s.hash, userId: s.user_id, tags: [row.tag] }),
					matchedPositions: new Set(),
				};
				stickerMap.set(s.id, entry);
			}
			for (let i = 0; i < normalized.length; i++) {
				if (row.tag.includes(normalized[i])) {
					entry.matchedPositions.add(i);
				}
			}
		}

		const scored = [...stickerMap.values()]
			.filter(({ matchedPositions }) => matchedPositions.size === normalized.length)
			.map(({ sticker, matchedPositions }) => ({
				sticker,
				positionScore: [...matchedPositions].reduce((sum, pos) => sum + pos, 0),
			}));

		scored.sort((a, b) => a.positionScore - b.positionScore);

		return scored.slice(0, limit).map((s) => s.sticker);
	}
}
