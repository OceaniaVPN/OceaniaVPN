export const STORAGE_VERSION = 1;

// KV is schemaless, so initialization is intentionally lightweight.
// Keeping this hook separate mirrors the CDZ-Bot database/init layer and gives
// us one place for future migrations without touching command handlers.
export async function ensureStorage(env) {
  if (!env?.BOT_STATE) throw new Error("BOT_STATE KV binding is missing");
  return { ok: true, version: STORAGE_VERSION };
}
