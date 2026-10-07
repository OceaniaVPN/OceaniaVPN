CREATE TABLE IF NOT EXISTS bot_kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  metadata TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_kv_expires ON bot_kv(expires_at);
CREATE INDEX IF NOT EXISTS idx_bot_kv_key ON bot_kv(key);
