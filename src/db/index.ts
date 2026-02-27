import path from "node:path";
import Database from "better-sqlite3";

import { logger } from "../_lib/logger.js";

const DB_PATH = path.resolve("stickersearch.db");

export let db: Database.Database;

export function init(): void {
	db = new Database(DB_PATH);

	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash VARCHAR(64) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(hash, user_id)
    );

    CREATE TABLE IF NOT EXISTS sticker_tags (
      sticker_id INTEGER NOT NULL,
      tag VARCHAR(128) NOT NULL,
      PRIMARY KEY (sticker_id, tag),
      FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sticker_tags_tag ON sticker_tags(tag);
  `);

	logger.info("Database initialized.");
}

export function shutdown(): void {
	db?.close();
	logger.info("Database closed.");
}
