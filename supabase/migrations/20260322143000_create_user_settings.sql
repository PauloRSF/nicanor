CREATE TABLE IF NOT EXISTS user_settings (
  user_id VARCHAR(128) PRIMARY KEY,
  sticker_tagging_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);
