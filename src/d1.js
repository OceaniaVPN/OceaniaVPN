const TABLE = "bot_kv";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  metadata TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
)`;

function normalizeMetadata(metadata) {
  return metadata == null ? null : JSON.stringify(metadata);
}

export function createD1Store(db) {
  if (!db) return null;

  let schemaPromise;
  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = db.prepare(SCHEMA_SQL).run();
    }
    return schemaPromise;
  };

  return {
    async get(key, type) {
      await ensureSchema();
      const row = await db.prepare(
        "SELECT value, metadata, expires_at FROM bot_kv WHERE key = ?1"
      ).bind(String(key)).first();

      if (!row) return null;
      if (row.expires_at && Number(row.expires_at) <= Date.now()) {
        await db.prepare("DELETE FROM bot_kv WHERE key = ?1").bind(String(key)).run();
        return null;
      }

      const value = row.value ?? null;
      if (type === "json") {
        try { return value == null ? null : JSON.parse(value); } catch { return null; }
      }
      return value;
    },

    async put(key, value, options = {}) {
      await ensureSchema();
      const ttl = Number(options.expirationTtl || 0);
      const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : null;
      const metadata = normalizeMetadata(options.metadata);

      await db.prepare(
        `INSERT INTO bot_kv (key, value, metadata, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,
           metadata=excluded.metadata,
           expires_at=excluded.expires_at,
           updated_at=excluded.updated_at`
      ).bind(String(key), String(value ?? ""), metadata, expiresAt, Date.now()).run();
    },

    async delete(key) {
      await ensureSchema();
      await db.prepare("DELETE FROM bot_kv WHERE key = ?1").bind(String(key)).run();
    },

    async list(options = {}) {
      await ensureSchema();
      const prefix = String(options.prefix || "");
      const limit = Math.min(Math.max(Number(options.limit || 1000), 1), 1000);
      const cursor = Number(options.cursor || 0);

      const result = await db.prepare(
        "SELECT key, metadata, expires_at FROM bot_kv WHERE key LIKE ?1 AND (expires_at IS NULL OR expires_at > ?2) ORDER BY key LIMIT ?3 OFFSET ?4"
      ).bind(prefix + "%", Date.now(), limit + 1, cursor).all();

      const rows = result.results || [];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        keys: page.map(row => ({
          name: row.key,
          metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata); } catch { return null; } })() : null
        })),
        list_complete: !hasMore,
        cursor: hasMore ? String(cursor + limit) : undefined
      };
    }
  };
}
