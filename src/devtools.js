import { getFileContent, listAllUsers } from "./github.js";
import { sendMessage } from "./telegram.js";

function escape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function protocolOf(uri) {
  const i = String(uri || "").indexOf("://");
  return i === -1 ? "?" : String(uri).slice(0, i).toUpperCase();
}

function extractHostPort(uri) {
  try {
    if (uri.startsWith("vmess://")) {
      const raw = uri.slice(8);
      const text = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      const json = JSON.parse(text);
      const port = Number.parseInt(json.port, 10);
      return json.add && port ? { host: json.add, port } : null;
    }
    const m = uri.match(/@([^:/?#]+):(\d+)/);
    return m ? { host: m[1], port: Number.parseInt(m[2], 10) } : null;
  } catch {
    return null;
  }
}

async function pingOne(uri, timeoutMs = 2500) {
  const target = extractHostPort(uri);
  if (!target) return { ok: false, ms: null, error: "нет host:port" };
  const started = Date.now();
  let socket;
  try {
    const { connect } = await import("cloudflare:sockets");
    socket = connect({ hostname: target.host, port: target.port });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
    await Promise.race([socket.opened, timeout]);
    return { ok: true, ms: Date.now() - started, host: target.host, port: target.port };
  } catch (e) {
    return { ok: false, ms: null, host: target.host, port: target.port, error: e?.message || "timeout" };
  } finally {
    try { if (socket) socket.close(); } catch {}
  }
}

export async function pingServers(uris, options = {}) {
  const concurrency = Math.max(1, Math.min(8, options.concurrency || 6));
  const timeoutMs = options.timeoutMs || 2500;
  const results = new Array(uris.length);
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= uris.length) return;
      results[i] = await pingOne(uris[i], timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uris.length) }, worker));
  return results;
}

export async function cmdDev(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ <b>Раздел разработчика</b>\n\nНет прав доступа.");
  const users = await listAllUsers(cfg);
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  const serverCount = content ? content.split("\n").filter(x => x.trim() && !x.startsWith("#")).length : 0;
  await sendMessage(cfg.telegramToken, chatId,
    `🧰 <b>DEV CONTROL CENTER</b>\n<i>Диагностика · сеть · данные · эксплуатация</i>\n\n━━━━━━━━━━━━━━━━━━━━\n👥 Пользователей: <code>${users.length}</code>\n📡 Ваших серверов: <code>${serverCount}</code>\n⚙️ Runtime: <code>Cloudflare Worker</code>\n━━━━━━━━━━━━━━━━━━━━\n\nВыбери инструмент:`,
    { inline_keyboard: [
      [{ text: "📡 Ping / Latency", callback_data: "dev_ping" }],
      [{ text: "🩺 Диагностика", callback_data: "dev_diag" }, { text: "📊 Метрики", callback_data: "dev_metrics" }],
      [{ text: "🔍 Декодер", callback_data: "decode" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }]
    ] });
}

export async function cmdDevPing(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  const uris = content ? content.split("\n").filter(x => x.trim() && !x.startsWith("#")) : [];
  if (!uris.length) return sendMessage(cfg.telegramToken, chatId, "📭 <b>Нет серверов для проверки.</b>", { inline_keyboard: [[{ text: "🧰 DEV Center", callback_data: "dev" }]] });
  const results = await pingServers(uris, { concurrency: 6, timeoutMs: 2500 });
  const alive = results.filter(x => x?.ok);
  const times = alive.map(x => x.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const min = times.length ? times[0] : null;
  const max = times.length ? times[times.length - 1] : null;
  let msg = `📡 <b>Ping / Latency</b>\n<i>Реальное TCP-время установления соединения</i>\n\n━━━━━━━━━━━━━━━━━━━━\n🟢 Онлайн: <code>${alive.length}</code>\n🔴 Offline: <code>${uris.length - alive.length}</code>\n⚡ Средний: <code>${avg === null ? "—" : avg + " ms"}</code>\n⬇️ Минимум: <code>${min === null ? "—" : min + " ms"}</code>\n⬆️ Максимум: <code>${max === null ? "—" : max + " ms"}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  results.slice(0, 30).forEach((r, i) => {
    const icon = r.ok ? "🟢" : "🔴";
    const latency = r.ok ? `${r.ms} ms` : "timeout";
    msg += `${icon} <b>${i + 1}.</b> ${protocolOf(uris[i])} · <code>${escape(latency)}</code>\n`;
  });
  if (uris.length > 30) msg += `\n<i>Показаны первые 30 из ${uris.length}.</i>`;
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🔄 Проверить снова", callback_data: "dev_ping" }], [{ text: "🧰 DEV Center", callback_data: "dev" }, { text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdDevDiag(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  const checks = [];
  try { const users = await listAllUsers(cfg); checks.push(["GitHub storage", true, `${users.length} users`]); } catch (e) { checks.push(["GitHub storage", false, e?.message || "error"]); }
  try { await cfg.kv.put(`dev_diag_${chatId}`, String(Date.now()), { expirationTtl: 60 }); const v = await cfg.kv.get(`dev_diag_${chatId}`); checks.push(["KV", v !== null, v !== null ? "read/write OK" : "read failed"]); } catch (e) { checks.push(["KV", false, e?.message || "error"]); }
  checks.push(["Admin auth", userId === cfg.adminId, "local check"]);
  let msg = `🩺 <b>Системная диагностика</b>\n\n`;
  for (const [name, ok, detail] of checks) msg += `${ok ? "✅" : "❌"} <b>${escape(name)}</b> — <code>${escape(detail)}</code>\n`;
  msg += `\n<i>Диагностика не меняет подписки и конфигурации.</i>`;
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🧰 DEV Center", callback_data: "dev" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdDevMetrics(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  const users = await listAllUsers(cfg);
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  const lines = content ? content.split("\n") : [];
  const links = lines.filter(x => x.trim() && !x.startsWith("#"));
  const byProtocol = {};
  for (const uri of links) {
    const p = protocolOf(uri);
    byProtocol[p] = (byProtocol[p] || 0) + 1;
  }
  const protocols = Object.entries(byProtocol).map(([k, v]) => `${k}: <b>${v}</b>`).join(" · ") || "нет данных";
  await sendMessage(cfg.telegramToken, chatId, `📊 <b>Метрики</b>\n\n👥 Пользователей: <code>${users.length}</code>\n📡 Серверов в вашем профиле: <code>${links.length}</code>\n🔌 Протоколы: ${protocols}\n\n🧠 Декодер: <code>8 UA / redirect / envelope</code>\n🛡 Storage: <code>GitHub + KV</code>`, { inline_keyboard: [[{ text: "🧰 DEV Center", callback_data: "dev" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}
