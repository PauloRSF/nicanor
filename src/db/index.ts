import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.resolve("stickersearch.db");

let db: Database.Database;

export interface Sticker {
  id: number;
  file_path: string;
  file_hash: string;
  chat_jid: string;
  created_at: string;
}

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      file_hash TEXT UNIQUE NOT NULL,
      chat_jid TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sticker_tags (
      sticker_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (sticker_id, tag),
      FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sticker_tags_tag ON sticker_tags(tag);
  `);
}

/**
 * Insert a new sticker or return the existing one if the hash already exists.
 * Updates chat_jid so "last sticker" tracking works even for duplicates.
 */
export function upsertSticker(
  filePath: string,
  fileHash: string,
  chatJid: string
): Sticker {
  const existing = db
    .prepare("SELECT * FROM stickers WHERE file_hash = ?")
    .get(fileHash) as Sticker | undefined;

  if (existing) {
    db.prepare("UPDATE stickers SET chat_jid = ? WHERE id = ?").run(
      chatJid,
      existing.id
    );
    return { ...existing, chat_jid: chatJid };
  }

  const result = db
    .prepare(
      "INSERT INTO stickers (file_path, file_hash, chat_jid) VALUES (?, ?, ?)"
    )
    .run(filePath, fileHash, chatJid);

  return {
    id: Number(result.lastInsertRowid),
    file_path: filePath,
    file_hash: fileHash,
    chat_jid: chatJid,
    created_at: new Date().toISOString(),
  };
}

export function addTags(stickerId: number, tags: string[]): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sticker_tags (sticker_id, tag) VALUES (?, ?)"
  );
  const transaction = db.transaction((tags: string[]) => {
    for (const tag of tags) {
      insert.run(stickerId, tag.toLowerCase().trim());
    }
  });
  transaction(tags);
}

export function getTagsForSticker(stickerId: number): string[] {
  const rows = db
    .prepare("SELECT tag FROM sticker_tags WHERE sticker_id = ?")
    .all(stickerId) as { tag: string }[];
  return rows.map((r) => r.tag);
}

/**
 * Search stickers that match ALL given tags. When a single tag is provided,
 * acts as a simple single-tag search. Results are ranked by the sum of matched
 * tag positions (ascending) — earlier tags in the query are weighted higher,
 * so matching via tag at position 0 is more relevant than position 2.
 */
export function searchByTags(queryTags: string[], limit = 5): Sticker[] {
  const normalized = queryTags.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) return [];

  const whereClauses = normalized.map(() => "st.tag LIKE ?");
  const patterns = normalized.map((t) => `%${t}%`);

  const rows = db
    .prepare(
      `SELECT s.*, st.tag AS matched_tag
       FROM stickers s
       JOIN sticker_tags st ON s.id = st.sticker_id
       WHERE ${whereClauses.join(" OR ")}`
    )
    .all(...patterns) as (Sticker & { matched_tag: string })[];

  const stickerMap = new Map<
    number,
    { sticker: Sticker; matchedPositions: Set<number> }
  >();

  for (const row of rows) {
    let entry = stickerMap.get(row.id);
    if (!entry) {
      entry = {
        sticker: {
          id: row.id,
          file_path: row.file_path,
          file_hash: row.file_hash,
          chat_jid: row.chat_jid,
          created_at: row.created_at,
        },
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

export function getStickerByHash(fileHash: string): Sticker | undefined {
  return db
    .prepare("SELECT * FROM stickers WHERE file_hash = ?")
    .get(fileHash) as Sticker | undefined;
}

export function getLastSticker(chatJid: string): Sticker | undefined {
  return db
    .prepare(
      "SELECT * FROM stickers WHERE chat_jid = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(chatJid) as Sticker | undefined;
}

export function deleteSticker(stickerId: number): string | null {
  const sticker = db
    .prepare("SELECT file_path FROM stickers WHERE id = ?")
    .get(stickerId) as { file_path: string } | undefined;

  if (!sticker) return null;

  db.prepare("DELETE FROM sticker_tags WHERE sticker_id = ?").run(stickerId);
  db.prepare("DELETE FROM stickers WHERE id = ?").run(stickerId);

  try {
    fs.unlinkSync(sticker.file_path);
  } catch {
    // file may already be gone
  }

  return sticker.file_path;
}
