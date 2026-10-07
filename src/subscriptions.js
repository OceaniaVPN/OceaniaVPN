import { getFileContent } from "./github.js";

const INDEX_PREFIX = "subscriptions_";
const ACTIVE_PREFIX = "active_subscription_";

function indexKey(chatId) { return `${INDEX_PREFIX}${chatId}`; }
function activeKey(chatId) { return `${ACTIVE_PREFIX}${chatId}`; }

async function readIndex(cfg, chatId) {
  if (!cfg.kv) return [];
  const value = await cfg.kv.get(indexKey(chatId), "json");
  return Array.isArray(value) ? value : [];
}

async function writeIndex(cfg, chatId, items) {
  if (!cfg.kv) throw new Error("BOT_STATE KV is required for multiple subscriptions");
  await cfg.kv.put(indexKey(chatId), JSON.stringify(items));
}

export async function ensureSubscriptionIndex(cfg, chatId) {
  let items = await readIndex(cfg, chatId);
  if (items.length) return items;

  const legacyFilename = `user_${chatId}.txt`;
  const legacy = await getFileContent(cfg, legacyFilename);
  if (!legacy) return [];

  const item = {
    id: "default",
    filename: legacyFilename,
    title: "Моя подписка",
    createdAt: Date.now(),
  };
  items = [item];
  await writeIndex(cfg, chatId, items);
  await cfg.kv.put(activeKey(chatId), item.id);
  return items;
}

export async function listSubscriptions(cfg, chatId) {
  return ensureSubscriptionIndex(cfg, chatId);
}

export async function getActiveSubscription(cfg, chatId) {
  const items = await ensureSubscriptionIndex(cfg, chatId);
  if (!items.length) return null;

  let activeId = cfg.kv ? await cfg.kv.get(activeKey(chatId)) : null;
  let active = items.find((item) => item.id === activeId);
  if (!active) {
    active = items[0];
    if (cfg.kv) await cfg.kv.put(activeKey(chatId), active.id);
  }
  return active;
}

export async function getActiveFilename(cfg, chatId) {
  const active = await getActiveSubscription(cfg, chatId);
  return active?.filename || `user_${chatId}.txt`;
}

export async function createSubscription(cfg, chatId, { title = "Моя подписка" } = {}) {
  if (!cfg.kv) throw new Error("BOT_STATE KV is required for multiple subscriptions");
  const items = await ensureSubscriptionIndex(cfg, chatId);
  const id = crypto.randomUUID().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 32);
  const item = {
    id,
    filename: `user_${chatId}_${id}.txt`,
    title: String(title || "Моя подписка").slice(0, 80),
    createdAt: Date.now(),
  };
  items.push(item);
  await writeIndex(cfg, chatId, items);
  await cfg.kv.put(activeKey(chatId), item.id);
  return item;
}

export async function setActiveSubscription(cfg, chatId, id) {
  const items = await ensureSubscriptionIndex(cfg, chatId);
  const item = items.find((entry) => entry.id === id);
  if (!item) return null;
  await cfg.kv.put(activeKey(chatId), item.id);
  return item;
}

export async function deleteSubscriptionRecord(cfg, chatId, id) {
  const items = await ensureSubscriptionIndex(cfg, chatId);
  const deleted = items.find((item) => item.id === id);
  if (!deleted) return { deleted: null, items };

  const next = items.filter((item) => item.id !== id);
  await writeIndex(cfg, chatId, next);
  const activeId = cfg.kv ? await cfg.kv.get(activeKey(chatId)) : null;
  if (activeId === id) {
    if (next.length) await cfg.kv.put(activeKey(chatId), next[0].id);
    else await cfg.kv.delete(activeKey(chatId));
  }
  return { deleted, items: next };
}
