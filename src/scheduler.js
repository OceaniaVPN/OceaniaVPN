import { getActiveSubscription, listSubscriptions } from "./subscriptions.js";
import { getFileContent, createOrUpdateFile } from "./github.js";

const PREFIX = "scheduled_";
const MAX_ITEMS = 100;

function key(chatId) {
  return `${PREFIX}${chatId}`;
}

function normalizeUri(value) {
  return String(value || "").trim();
}

function parseWhen(dateText, timeText) {
  const raw = `${String(dateText || "").trim()} ${String(timeText || "").trim()}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return 0;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00+03:00`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

async function read(cfg, chatId) {
  const value = await cfg.store.get(key(chatId), "json");
  return Array.isArray(value) ? value : [];
}

async function write(cfg, chatId, items) {
  await cfg.store.put(key(chatId), JSON.stringify(items.slice(0, MAX_ITEMS)));
}

export async function listScheduledChanges(cfg, chatId) {
  return (await read(cfg, chatId)).sort((a, b) => a.executeAt - b.executeAt);
}

export async function addScheduledChange(cfg, chatId, { action, date, time, uri }) {
  if (!["add", "remove"].includes(action)) throw new Error("Действие должно быть add или remove");
  const normalizedUri = normalizeUri(uri);
  if (!normalizedUri) throw new Error("Не указан сервер");
  const executeAt = parseWhen(date, time);
  if (!executeAt || executeAt <= Date.now()) throw new Error("Укажи время в будущем: YYYY-MM-DD HH:mm");

  const active = await getActiveSubscription(cfg, chatId);
  if (!active) throw new Error("Сначала создай подписку");
  const items = await read(cfg, chatId);
  if (items.length >= MAX_ITEMS) throw new Error(`Можно иметь максимум ${MAX_ITEMS} черновиков`);

  const duplicate = items.some((item) =>
    item.subscriptionId === active.id &&
    item.action === action &&
    item.uri === normalizedUri &&
    item.executeAt === executeAt
  );
  if (duplicate) throw new Error("Такое изменение уже запланировано");

  const item = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 10),
    subscriptionId: active.id,
    subscriptionTitle: active.title || "Моя подписка",
    action,
    uri: normalizedUri,
    executeAt,
    createdAt: Date.now(),
  };
  items.push(item);
  await write(cfg, chatId, items);
  return item;
}

export async function cancelScheduledChange(cfg, chatId, id) {
  const items = await read(cfg, chatId);
  const found = items.find((item) => item.id === id);
  if (!found) return null;
  await write(cfg, chatId, items.filter((item) => item.id !== id));
  return found;
}

function splitFile(content) {
  const lines = String(content || "").split("\n");
  const headers = [];
  const links = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") headers.push(line);
    else links.push(line.trim());
  }
  return { headers, links: links.filter(Boolean) };
}

function sameUri(a, b) {
  return String(a).trim() === String(b).trim();
}

export async function processScheduledChanges(cfg) {
  if (!cfg.store) return { processed: 0, failed: 0 };
  const page = await cfg.store.list({ prefix: PREFIX, limit: 1000 });
  const keys = page.keys || [];
  const now = Date.now();
  let processed = 0;
  let failed = 0;

  for (const keyItem of keys) {
    const chatId = keyItem.name.slice(PREFIX.length);
    if (!chatId) continue;
    const items = await read(cfg, chatId);
    const due = items.filter((item) => Number(item.executeAt) <= now);
    if (!due.length) continue;

    const pending = [...items];
    for (const item of due) {
      try {
        const subscriptions = await listSubscriptions(cfg, chatId);
        const subscription = subscriptions.find((entry) => entry.id === item.subscriptionId);
        if (!subscription) throw new Error("Подписка удалена");

        const content = await getFileContent(cfg, subscription.filename);
        if (!content) throw new Error("Файл подписки не найден");

        const { headers, links } = splitFile(content);
        let nextLinks = links;
        if (item.action === "add") {
          if (!nextLinks.some((uri) => sameUri(uri, item.uri))) nextLinks = [...nextLinks, item.uri];
        } else {
          nextLinks = nextLinks.filter((uri) => !sameUri(uri, item.uri));
        }

        const nextContent = [...headers, ...nextLinks].join("\n");
        const res = await createOrUpdateFile(
          cfg,
          subscription.filename,
          nextContent,
          `Scheduled ${item.action} server for subscription ${subscription.id}`
        );
        if (!(res.content || res.sha || res.commit)) throw new Error(res.message || "GitHub save failed");

        const index = pending.findIndex((entry) => entry.id === item.id);
        if (index !== -1) pending.splice(index, 1);
        processed++;
      } catch (error) {
        failed++;
        console.error("[Schedule] Failed item", item.id, error);
      }
    }

    await write(cfg, chatId, pending);
  }

  return { processed, failed };
}
