CREATE TABLE IF NOT EXISTS stickers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash VARCHAR(64) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_sent_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hash, user_id)
);

CREATE TABLE IF NOT EXISTS sticker_tags (
  sticker_id BIGINT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
  tag VARCHAR(128) NOT NULL,
  PRIMARY KEY (sticker_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_sticker_tags_tag ON sticker_tags(tag);
