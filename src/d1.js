
function normalizeMetadata(metadata) {
  return metadata == null ? null : JSON.stringify(metadata);
}

export function createD1Store(db) {
  if (!db) return null;

  let schemaPromise;
  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await db.prepare(`CREATE TABLE IF NOT EXISTS bot_kv (
          key TEXT PRIMARY KEY,
          value TEXT,
          metadata TEXT,
          expires_at INTEGER,
          updated_at INTEGER NOT NULL
        )`).run();
        await db.prepare(`CREATE TABLE IF NOT EXISTS subscription_devices (
          subscription_key TEXT NOT NULL,
          hwid TEXT NOT NULL,
          device_ref TEXT NOT NULL,
          device_os TEXT,
          device_model TEXT,
          user_agent TEXT,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          last_ip TEXT,
          PRIMARY KEY (subscription_key, hwid),
          UNIQUE (subscription_key, device_ref)
        )`).run();
        await db.prepare("CREATE INDEX IF NOT EXISTS idx_subscription_devices_key ON subscription_devices(subscription_key, last_seen)").run();
      })();
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
    },

    async registerSubscriptionDevice({ subscriptionKey, hwid, deviceRef, deviceOs, deviceModel, userAgent, ip, limit }) {
      await ensureSchema();
      const now = Date.now();
      const maxDevices = Math.max(0, Number.parseInt(limit, 10) || 0);
      // One conditional INSERT is used for both capacity checking and claiming the slot.
      // SQLite serializes writes; the UNIQUE(subscription_key, hwid) key prevents double counting.
      await db.prepare(`
        INSERT INTO subscription_devices
          (subscription_key, hwid, device_ref, device_os, device_model, user_agent, first_seen, last_seen, last_ip)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8
        WHERE ?9 = 0
          OR EXISTS (SELECT 1 FROM subscription_devices WHERE subscription_key = ?1 AND hwid = ?2)
          OR (SELECT COUNT(*) FROM subscription_devices WHERE subscription_key = ?1) < ?9
        ON CONFLICT(subscription_key, hwid) DO UPDATE SET
          device_os = excluded.device_os,
          device_model = excluded.device_model,
          user_agent = excluded.user_agent,
          last_seen = excluded.last_seen,
          last_ip = excluded.last_ip
      `).bind(
        String(subscriptionKey), String(hwid), String(deviceRef), String(deviceOs || "").slice(0, 80),
        String(deviceModel || "").slice(0, 160), String(userAgent || "").slice(0, 240), now,
        String(ip || "").slice(0, 80), maxDevices
      ).run();

      const device = await db.prepare(
        "SELECT subscription_key, hwid, device_ref, device_os, device_model, user_agent, first_seen, last_seen, last_ip FROM subscription_devices WHERE subscription_key = ?1 AND hwid = ?2"
      ).bind(String(subscriptionKey), String(hwid)).first();
      const countRow = await db.prepare(
        "SELECT COUNT(*) AS count FROM subscription_devices WHERE subscription_key = ?1"
      ).bind(String(subscriptionKey)).first();
      return { allowed: Boolean(device), device: device || null, count: Number(countRow?.count || 0), limit: maxDevices };
    },

    async listSubscriptionDevices(subscriptionKey) {
      await ensureSchema();
      const result = await db.prepare(
        "SELECT subscription_key, hwid, device_ref, device_os, device_model, user_agent, first_seen, last_seen, last_ip FROM subscription_devices WHERE subscription_key = ?1 ORDER BY last_seen DESC"
      ).bind(String(subscriptionKey)).all();
      return result.results || [];
    },

    async removeSubscriptionDevice(subscriptionKey, deviceRef) {
      await ensureSchema();
      const result = await db.prepare(
        "DELETE FROM subscription_devices WHERE subscription_key = ?1 AND device_ref = ?2"
      ).bind(String(subscriptionKey), String(deviceRef)).run();
      return Number(result?.meta?.changes || 0) > 0;
    },

    async countSubscriptionDevices(subscriptionKey) {
      await ensureSchema();
      const result = await db.prepare(
        "SELECT COUNT(*) AS count FROM subscription_devices WHERE subscription_key = ?1"
      ).bind(String(subscriptionKey)).first();
      return Number(result?.count || 0);
    },

    async trimSubscriptionDevices(subscriptionKey, limit) {
      await ensureSchema();
      const maxDevices = Math.max(0, Number.parseInt(limit, 10) || 0);
      if (maxDevices === 0) return 0;
      const result = await db.prepare(`
        DELETE FROM subscription_devices
        WHERE subscription_key = ?1
          AND device_ref IN (
            SELECT device_ref FROM subscription_devices
            WHERE subscription_key = ?1
            ORDER BY last_seen DESC, first_seen ASC
            LIMIT -1 OFFSET ?2
          )
      `).bind(String(subscriptionKey), maxDevices).run();
      return Number(result?.meta?.changes || 0);
    }
  };
}
