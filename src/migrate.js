const MIGRATION_KEY = "__migration:kv-to-d1:v1";

function ttlFromExpiration(expiration) {
  if (!expiration) return 0;
  const seconds = Math.floor(Number(expiration) - Date.now() / 1000);
  return Math.max(0, seconds);
}

export async function migrateLegacyKvToD1(cfg) {
  const kv = cfg.legacyKv;
  const d1 = cfg.db;
  if (!kv || !d1) return { migrated: 0, skipped: true };

  const done = await d1.get(MIGRATION_KEY);
  if (done) return { migrated: 0, skipped: true, complete: true };

  let cursor;
  let migrated = 0;

  do {
    const page = await kv.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.keys || [];

    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const names = batch.map((item) => item.name);
      const values = await kv.get(names, "text");

      for (const item of batch) {
        // Device tracking was removed; never migrate its historical high-volume keys.
        if (String(item.name || "").startsWith("subscription_device:")) continue;

        const value = values instanceof Map ? values.get(item.name) : null;
        if (value == null) continue;

        const ttl = ttlFromExpiration(item.expiration);
        if (item.expiration && ttl <= 0) continue;

        await d1.put(item.name, value, {
          ...(ttl > 0 ? { expirationTtl: Math.max(ttl, 60) } : {}),
          ...(item.metadata != null ? { metadata: item.metadata } : {}),
        });
        migrated++;
      }
    }

    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  await d1.put(MIGRATION_KEY, String(Date.now()));
  return { migrated, complete: true };
}
