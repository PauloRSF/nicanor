import crypto from "node:crypto";

import { db } from "../db/index.js";
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

		const row = db
			.prepare<[string, string], StickerRow>(
				`INSERT INTO stickers (hash, user_id) VALUES (?, ?)
				 ON CONFLICT (hash, user_id) DO UPDATE SET last_sent_at = CURRENT_TIMESTAMP
				 RETURNING *`,
			)
			.get(hash, this.userId);

		if (!row) throw new Error(`Failed to upsert sticker: hash=${hash}, userId=${this.userId}`);

		await StickerStorage.save(hash, this.data);

    const tags = db
      .prepare<[Sticker["id"]], { tag: string }>("SELECT tag FROM sticker_tags WHERE sticker_id = ?")
      .all(row.id);

		return new Sticker({ id: row.id, hash, userId: this.userId, tags: tags.map((t) => t.tag) });
	}

	get hash(): string {
		if (this.cachedHash) return this.cachedHash;

		this.cachedHash = crypto.createHash("sha256").update(this.data).digest("hex");

		return this.cachedHash;
	}
}

type StickerRow = {
	id: number;
	hash: string;
	user_id: string;
	created_at: string;
};

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
		const deleteTags = db.prepare("DELETE FROM sticker_tags WHERE sticker_id = ?");
		const insertTag = db.prepare("INSERT OR IGNORE INTO sticker_tags (sticker_id, tag) VALUES (?, ?)");

		const transaction = db.transaction((tags: string[]) => {
			deleteTags.run(this.id);

			for (const raw of tags) {
				const tag = sanitizeTag(raw);

				if (tag) insertTag.run(this.id, tag);
			}
		});

		transaction(this.tags);
	}

	async delete(): Promise<void> {
		const { hash } = this;

		db.prepare("DELETE FROM sticker_tags WHERE sticker_id = ?").run(this.id);
		db.prepare("DELETE FROM stickers WHERE id = ?").run(this.id);

		const othersWithSameHash = db
			.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM stickers WHERE hash = ?")
			.get(hash);

		if (!othersWithSameHash || othersWithSameHash.count === 0) {
			await StickerStorage.delete(hash);
		}
	}

	static async getLastByUserId(userId: string): Promise<Sticker | null> {
		const row = db
			.prepare<[string], StickerRow>("SELECT * FROM stickers WHERE user_id = ? ORDER BY last_sent_at DESC LIMIT 1")
			.get(userId);

		if (!row) return null;

		const tags = db
			.prepare<[Sticker["id"]], { tag: string }>("SELECT tag FROM sticker_tags WHERE sticker_id = ?")
			.all(row.id);

		return new Sticker({ id: row.id, hash: row.hash, userId: row.user_id, tags: tags.map((t) => t.tag) });
	}

	static async searchByTags(userId: string, tags: string[], limit = MAX_SEARCH_RESULTS): Promise<Sticker[]> {
		const normalized = tags.map(sanitizeTag).filter(Boolean);
		if (normalized.length === 0) return [];

		const tagClauses = normalized.map(() => "st.tag LIKE ?");
		const patterns = normalized.map((t) => `%${t}%`);

		const rows = db
			.prepare(
				`SELECT s.*, st.tag AS matched_tag
         FROM stickers s
         JOIN sticker_tags st ON s.id = st.sticker_id
         WHERE s.user_id = ? AND (${tagClauses.join(" OR ")})`,
			)
			.all(userId, ...patterns) as (StickerRow & { matched_tag: string })[];

		const stickerMap = new Map<Sticker["id"], { sticker: Sticker; matchedPositions: Set<number> }>();

		for (const row of rows) {
			let entry = stickerMap.get(row.id);
			if (!entry) {
				entry = {
					sticker: new Sticker({ id: row.id, hash: row.hash, userId: row.user_id, tags: [row.matched_tag] }),
					matchedPositions: new Set(),
				};
				stickerMap.set(row.id, entry);
			}
			for (let i = 0; i < normalized.length; i++) {
				if (row.matched_tag.includes(normalized[i])) {
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
