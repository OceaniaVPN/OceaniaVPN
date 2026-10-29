import { decodeSubscription } from "./decoder.js";
import { decryptCrypt5 } from "./crypt5.js";
import { getFileContent, createOrUpdateFile } from "./github.js";
import { listSubscriptions } from "./subscriptions.js";
import { sendMessage } from "./telegram.js";

const PREFIX = "autodecode_";
export const AUTO_DECODE_INTERVAL_MS = 5 * 60 * 60 * 1000;
const MAX_AUTO_SERVERS = 5000;

export function autoDecodeKey(chatId, subscriptionId) {
  return `${PREFIX}${String(chatId)}_${String(subscriptionId)}`;
}

export async function getAutoDecodeConfig(cfg, chatId, subscriptionId) {
  if (!cfg.store) return null;
  return cfg.store.get(autoDecodeKey(chatId, subscriptionId), "json");
}

function splitSubscriptionFile(content) {
  const headers = [];
  const links = [];
  for (const line of String(content || "").split(/\r?\n/)) {
    if (line.startsWith("#") || !line.trim()) headers.push(line);
    else links.push(line.trim());
  }
  return { headers, links };
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (/^happ:\/\/crypt5\//i.test(source)) {
    const decrypted = String(decryptCrypt5(source) || "").trim();
    let url;
    try { url = new URL(decrypted); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol)) {
      throw new Error("Crypt5 не расшифровался в HTTP(S)-ссылку.");
    }
    return source;
  }

  let url;
  try { url = new URL(source); } catch {}
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Отправь HTTP(S)-ссылку или happ://crypt5/...");
  }
  return url.toString();
}

async function resolveSource(value) {
  const source = normalizeSource(value);
  if (!/^happ:\/\/crypt5\//i.test(source)) return source;
  const decrypted = String(decryptCrypt5(source) || "").trim();
  let url;
  try { url = new URL(decrypted); } catch {}
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Crypt5 не расшифровался в HTTP(S)-ссылку.");
  }
  return url.toString();
}

export async function setAutoDecodeSource(cfg, chatId, subscriptionId, sourceUrl) {
  if (!cfg.store) throw new Error("Хранилище настроек недоступно.");
  const normalized = normalizeSource(sourceUrl);
  const key = autoDecodeKey(chatId, subscriptionId);
  const previous = await cfg.store.get(key, "json") || {};
  const value = {
    ...previous,
    chatId: String(chatId),
    subscriptionId: String(subscriptionId),
    sourceUrl: normalized,
    enabled: true,
    nextRunAt: Date.now(),
    lockUntil: 0,
    lastError: null,
  };
  await cfg.store.put(key, JSON.stringify(value));
  return value;
}

export async function setAutoDecodeEnabled(cfg, chatId, subscriptionId, enabled) {
  const key = autoDecodeKey(chatId, subscriptionId);
  const current = await getAutoDecodeConfig(cfg, chatId, subscriptionId);
  if (!current?.sourceUrl) throw new Error("Сначала укажи ссылку для Auto Decode.");
  const value = {
    ...current,
    enabled: Boolean(enabled),
    nextRunAt: enabled ? Date.now() : null,
    lockUntil: 0,
    lastError: null,
  };
  await cfg.store.put(key, JSON.stringify(value));
  return value;
}

export async function runAutoDecodeOnce(cfg, chatId, subscriptionId, options = {}) {
  const { automatic = false, notify = false } = options;
  if (!cfg.store) return { ok: false, error: "Хранилище настроек недоступно." };

  const key = autoDecodeKey(chatId, subscriptionId);
  const current = await getAutoDecodeConfig(cfg, chatId, subscriptionId);
  if (!current?.sourceUrl) return { ok: false, error: "Для этой подписки не настроен источник Auto Decode." };
  if (automatic && !current.enabled) return { skipped: true };
  const now = Date.now();
  if (Number(current.lockUntil || 0) > now) return { ok: false, error: "Обновление этой подписки уже выполняется." };

  const locked = { ...current, lockUntil: now + 10 * 60 * 1000 };
  await cfg.store.put(key, JSON.stringify(locked));

  try {
    const sourceUrl = await resolveSource(current.sourceUrl);
    const source = new URL(sourceUrl);
    const result = await decodeSubscription(sourceUrl, false, false, {
      apiToken: cfg.subscriptionApiSecret || "",
      apiOrigin: cfg.workerOrigin || "",
      upstreamSecret: cfg.subscriptionUpstreamSecret || "",
      upstreamOrigin: cfg.subscriptionUpstreamOrigin || "",
    });
    if (!result?.ok) throw new Error(result?.error || "Источник не удалось расшифровать.");

    const newUris = [...new Set((Array.isArray(result.uris) ? result.uris : [])
      .map(uri => String(uri || "").trim())
      .filter(uri => /^(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|wireguard|wg):\/\/\S+$/i.test(uri)))]
      .slice(0, MAX_AUTO_SERVERS);
    if (!newUris.length) {
      throw new Error("Источник вернул содержимое, но распознанных серверов нет. Старая подписка оставлена без изменений.");
    }

    const subscriptions = await listSubscriptions(cfg, chatId);
    const subscription = subscriptions.find(item => String(item.id) === String(subscriptionId));
    if (!subscription) throw new Error("Подписка не найдена. Возможно, её удалили.");
    const oldContent = await getFileContent(cfg, subscription.filename);
    if (oldContent === null) throw new Error("Файл подписки не найден; старое содержимое не изменено.");

    const { headers, links } = splitSubscriptionFile(oldContent);
    const previouslyManaged = new Set(Array.isArray(current.managedUris) ? current.managedUris : []);
    const manualUris = links.filter(uri => !previouslyManaged.has(uri));
    const nextLinks = [...new Set([...manualUris, ...newUris])];
    const nextContent = [...headers, ...nextLinks].join("\n");
    const saved = await createOrUpdateFile(
      cfg,
      subscription.filename,
      nextContent,
      `Auto Decode refresh for subscription ${subscription.id}`
    );
    if (!(saved.content || saved.sha || saved.commit)) {
      throw new Error(saved.message || "GitHub не подтвердил сохранение подписки.");
    }

    const completedAt = Date.now();
    const updated = {
      ...locked,
      managedUris: newUris,
      lastRunAt: completedAt,
      nextRunAt: current.enabled ? completedAt + AUTO_DECODE_INTERVAL_MS : null,
      lastCount: newUris.length,
      totalCount: nextLinks.length,
      lastError: null,
      lockUntil: 0,
    };
    await cfg.store.put(key, JSON.stringify(updated));
    console.log("[AutoDecode] Updated", JSON.stringify({
      chatId: String(chatId),
      subscriptionId: String(subscriptionId),
      sourceHost: source.hostname,
      parsedServers: newUris.length,
      totalServers: nextLinks.length,
    }));

    if (notify) {
      try {
        await sendMessage(cfg.telegramToken, chatId,
          `✅ <b>Auto Decode обновил подписку</b>\n\n📡 Серверов источника: <code>${newUris.length}</code>\n📋 Всего в подписке: <code>${nextLinks.length}</code>\n⏰ Следующее обновление примерно через 5 часов.`);
      } catch (notifyError) {
        console.warn("[AutoDecode] Update succeeded but Telegram notification failed:", notifyError?.message || notifyError);
      }
    }
    return { ok: true, parsedCount: newUris.length, totalCount: nextLinks.length, nextRunAt: updated.nextRunAt };
  } catch (error) {
    const message = String(error?.message || error || "Неизвестная ошибка").slice(0, 300);
    const failedAt = Date.now();
    const updated = {
      ...locked,
      lastRunAt: failedAt,
      nextRunAt: locked.enabled ? failedAt + AUTO_DECODE_INTERVAL_MS : null,
      lastError: message,
      lockUntil: 0,
    };
    await cfg.store.put(key, JSON.stringify(updated));
    console.error("[AutoDecode] Update failed", JSON.stringify({
      chatId: String(chatId),
      subscriptionId: String(subscriptionId),
      error: message,
    }));
    if (notify) {
      await sendMessage(cfg.telegramToken, chatId,
        `⚠️ <b>Auto Decode не смог обновить подписку</b>\n\n${message}\n\nСтарое содержимое подписки сохранено; можно запустить повторно из настроек.`);
    }
    return { ok: false, error: message };
  }
}

export async function processAutoDecodeSubscriptions(cfg) {
  if (!cfg.store?.list) return { processed: 0, failed: 0, skipped: 0 };
  let cursor = 0;
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const now = Date.now();

  while (true) {
    const page = await cfg.store.list({ prefix: PREFIX, limit: 500, cursor });
    for (const keyItem of page.keys || []) {
      const config = await cfg.store.get(keyItem.name, "json");
      if (!config?.enabled || !config?.sourceUrl || Number(config.nextRunAt || 0) > now) continue;
      if (Number(config.lockUntil || 0) > now) { skipped++; continue; }

      const result = await runAutoDecodeOnce(cfg, config.chatId, config.subscriptionId, {
        automatic: true,
        notify: true,
      });
      if (result.skipped) skipped++;
      else if (result.ok) processed++;
      else failed++;
    }
    if (!page.cursor) break;
    cursor = Number(page.cursor);
  }
  return { processed, failed, skipped };
}
