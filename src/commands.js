import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription, checkServersAlive } from "./decoder.js";
import { pingServers, cmdDev, cmdDevPing, cmdDevDiag, cmdDevMetrics } from "./devtools.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";
import { COUNTRIES, matchesCountryKey, detectCountryFromText } from "./contries.js";
import { cmdProxy, handleProxyDocument } from "./proxy.js";

function splitSubscriptionFile(content) {
  const lines = content.split("\n");
  const headers = [];
  const links = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") headers.push(line);
    else links.push(line);
  }
  return { headers, links };
}

function detectCountry(uri) {
  const hashIndex = uri.lastIndexOf('#');
  const remark = hashIndex !== -1 ? decodeURIComponent(uri.substring(hashIndex + 1)) : "";
  const fromRemark = detectCountryFromText(remark);
  if (fromRemark) return fromRemark;
  const hostMatch = uri.match(/@([^:/]+)/);
  const host = hostMatch ? hostMatch[1] : "";
  return detectCountryFromText(host);
}

function protocolOf(uri) {
  const idx = uri.indexOf("://");
  return idx === -1 ? "?" : uri.substring(0, idx).toUpperCase();
}

function userUrls(cfg, chatId) {
  return {
    subUrl: `${cfg.workerOrigin}/sub?u=${chatId}`,
    pageUrl: `${cfg.workerOrigin}/page?u=${chatId}`,
  };
}

function mainMenu(isAdmin = false) {
  const rows = [
    [{ text: "🚀  Создать подписку", callback_data: "create" }],
    [{ text: "📋  Моя подписка", callback_data: "my" }, { text: "📡  Серверы", callback_data: "list" }],
    [{ text: "🌐  Прокси-подписка", callback_data: "proxy" }],
    [{ text: "🔍  Декодер", callback_data: "decode" }, { text: "📤  Экспорт", callback_data: "export" }],
    [{ text: "🧰  Инструменты", callback_data: "tools" }, { text: "ℹ️  Помощь", callback_data: "help" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠  DEV Control Center", callback_data: "dev" }]);
  return { inline_keyboard: rows };
}

function backToMenuKeyboard() {
  return { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] };
}

const THEME_LIST = [
  { id: "beach", label: "🏖 Пляж" },
  { id: "forest", label: "🌲 Лес" },
  { id: "gori", label: "⛰ Горы" },
  { id: "ocean", label: "🌊 Океан" },
  { id: "pustinya", label: "🏜 Пустыня" },
  { id: "site", label: "🌐 Сайт" },
];

async function handleStepAnswer(cfg, chatId, text, state) {
  const step = state.step;
  const val = text.trim();
  state[step] = val.toLowerCase() === "none" ? null : val;
  const idx = STEPS.indexOf(step);
  if (idx < STEPS.length - 1) {
    state.step = STEPS[idx + 1];
    await setState(cfg, chatId, state);
    await sendMessage(cfg.telegramToken, chatId, STEP_MSG[state.step]);
  } else {
    await finalizeSubscription(cfg, chatId, state, []);
  }
}

async function finalizeSubscription(cfg, chatId, state, uris = []) {
  const userFile = `user_${chatId}.txt`;
  const content = buildFile(state, uris);
  const res = await createOrUpdateFile(cfg, userFile, content, `Subscription for user ${chatId}`);
  await clearState(cfg, chatId);
  if (res.content || res.sha) {
    const { subUrl, pageUrl } = userUrls(cfg, chatId);
    const kb = { inline_keyboard: [
      [{ text: "📋 Моя подписка", callback_data: "my" }],
      [{ text: "🎨 Страница подписки", url: pageUrl }, { text: "🖼 Сменить тему", callback_data: "theme_pick" }],
      [{ text: "📡 Список серверов", callback_data: "list" }],
      [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }],
      [{ text: "🗑 Удалить подписку", callback_data: "delete" }],
    ] };
    await sendMessage(cfg.telegramToken, chatId,
      `✅ <b>Подписка создана</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 Серверов: <code>${uris.length}</code>\n🔗 Ссылка:\n<code>${subUrl}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 Можно импортировать в v2rayNG, Hiddify, Shadowrocket или Clash Meta.`, kb);
  } else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
}

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  const links = content ? splitSubscriptionFile(content).links : [];
  const hasSubscription = Boolean(content);
  const status = hasSubscription ? "🟢 АКТИВНА" : "⚪ НЕ НАСТРОЕНА";
  const servers = hasSubscription ? links.length : 0;
  const admin = chatId === cfg.adminId;
  await sendMessage(cfg.telegramToken, chatId,
    `🌊 <b>OCEANIA VPN</b>\n<i>Control Center · быстрый доступ ко всему</i>\n\n` +
    `╭────────────────────╮\n` +
    `│ ${status}\n` +
    `│ 📡 Серверов: <b>${servers}</b>\n` +
    `│ 🔐 Профиль: <b>${hasSubscription ? "готов" : "пуст"}</b>\n` +
    `╰────────────────────╯\n\n` +
    `<b>Что делаем?</b>\n` +
    `Создаём профиль, проверяем серверы, декодируем подписки или открываем инструменты разработчика.`,
    mainMenu(admin));
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(cfg.telegramToken, chatId,
    `ℹ️ <b>OCEANIA VPN · Справка</b>\n\n` +
    `<b>Основное</b>\n/start · главное меню\n/create · создать подписку\n/my · мой профиль\n/list · серверы + проверка\n/add · добавить сервер/подписку\n/replace N · заменить сервер\n/delete N · удалить сервер\n/export · ссылки\n/decode URL · декодировать\n/proxy · прокси-подписки\n/cancel · отменить операцию\n\n` +
    `<b>Для разработчика</b>\n/users · пользователи\n/stats · статистика\n/dev · DEV Control Center\n\n` +
    `<b>Декодер</b>\nYAML · JSON · Base64 · URI · Happ/INCY/V2RayTun redirect · вложенные ссылки\n\n` +
    `<b>Мониторинг</b>\nВ списке серверов теперь показывается числовой TCP latency в миллисекундах.`,
    backToMenuKeyboard());
}

export async function cmdCreate(cfg, chatId) {
  await setState(cfg, chatId, { step: "title" });
  await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
}

export async function cmdCancel(cfg, chatId) {
  const state = await getState(cfg, chatId);
  if (state) { await clearState(cfg, chatId); await sendMessage(cfg.telegramToken, chatId, `❌ <b>Создание отменено.</b>`); }
  else await sendMessage(cfg.telegramToken, chatId, `ℹ️ Нет активного процесса.`);
}

export async function cmdDecode(cfg, chatId, url) {
  const inputUrl = String(url || "").trim();
  let parsedUrl;
  try { parsedUrl = new URL(inputUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    return sendMessage(cfg.telegramToken, chatId, `❌ <b>Нужна корректная HTTP(S)-ссылка</b>\n\n<code>/decode https://example.com/sub</code>\n\nИли отправь URL отдельным сообщением.`);
  }
  url = parsedUrl.toString();
  let loadingMsgId = null;
  try {
    const loadingMsg = await sendMessage(cfg.telegramToken, chatId, `⏳ <b>Декодирую подписку</b>\n\n🌐 Источник: <code>${escapeHtml(parsedUrl.hostname)}</code>\n🥷 Happ-compatible\n🔍 Формат → извлечение → сохранение...`);
    if (loadingMsg?.result?.message_id) loadingMsgId = loadingMsg.result.message_id;
    const result = await decodeSubscription(url, false, false);
    if (!result.ok) {
      const errorMsg = `❌ <b>Не удалось расшифровать</b>\n\n${result.error}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }
    const uris = result.uris || [];
    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, `⏳ <b>Найдено ${uris.length} конфигураций</b>\n\n💾 Сохраняю результат...`);
    const timestamp = Date.now().toString(36);
    const filename = `decoded_${chatId}_${timestamp}.txt`;
    const meta = result.metadata || {};
    const hostname = parsedUrl.hostname || "subscription";
    const content = buildFile({ title: meta["profile-title"] || `Decoded • ${hostname}`, interval: meta["profile-update-interval"] || 4, webpage: meta["profile-web-page-url"] || url, announce: meta.announce || null }, uris);
    const res = await createOrUpdateFile(cfg, filename, content, `Decode from ${hostname}`);
    if (!(res.content || res.sha)) {
      const errorMsg = `❌ <b>Ошибка сохранения</b>\n\n${res.message || "неизвестно"}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }
    const rawUrl = `${cfg.workerOrigin}/sub?f=${encodeURIComponent(filename)}`;
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, hysteria: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++; else if (u.startsWith("vmess://")) stats.vmess++; else if (u.startsWith("trojan://")) stats.trojan++; else if (u.startsWith("ss://")) stats.ss++; else if (u.startsWith("hysteria")) stats.hysteria++; else stats.other++;
    }
    const kb = { inline_keyboard: [[{ text: "📋 Открыть подписку", url: rawUrl }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] };
    const successMsg = `✅ <b>Подписка расшифрована</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 Серверов: <code>${uris.length}</code>\n🔌 VLESS <b>${stats.vless}</b> · VMess <b>${stats.vmess}</b>\n🔌 Trojan <b>${stats.trojan}</b> · SS <b>${stats.ss}</b>\n🔌 Hysteria <b>${stats.hysteria}</b> · Other <b>${stats.other}</b>\n━━━━━━━━━━━━━━━━━━━━\n🔗 <code>${rawUrl}</code>`;
    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb); else await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
  } catch (err) {
    const errorMsg = `⚠️ <b>Ошибка декодирования</b>\n\n<code>${escapeHtml(err.message)}</code>`;
    if (loadingMsgId) { try { await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); } catch { await sendMessage(cfg.telegramToken, chatId, errorMsg); } } else await sendMessage(cfg.telegramToken, chatId, errorMsg);
  }
}

export async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписка ещё не создана</b>\n\nСоздай профиль или импортируй URL.`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }, { text: "🔍 Декодировать", callback_data: "decode" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const { headers, links } = splitSubscriptionFile(content);
  const { subUrl: mySubUrl, pageUrl: myPageUrl } = userUrls(cfg, chatId);
  const msg = `📋 <b>МОЙ ПРОФИЛЬ</b>\n\n🟢 Статус: <b>АКТИВЕН</b>\n📡 Серверов: <code>${links.length}</code>\n\n<b>Параметры</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>`;
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🎨 Страница", url: myPageUrl }, { text: "🖼 Тема", callback_data: "theme_pick" }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "📤 Экспорт", callback_data: "export" }], [{ text: "🗑 Удалить", callback_data: "delete" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdList(cfg, chatId, page = 0) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписка ещё не создана</b>`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const { links } = splitSubscriptionFile(content);
  if (!links.length) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Серверов пока нет</b>`, { inline_keyboard: [[{ text: "➕ Добавить", callback_data: "add_prompt" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const PER_PAGE = 12;
  const totalPages = Math.max(1, Math.ceil(links.length / PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PER_PAGE;
  const pageLinks = links.slice(start, start + PER_PAGE);
  const results = await pingServers(pageLinks, { concurrency: 6, timeoutMs: 2500 });
  let msg = `📡 <b>СЕРВЕРЫ</b>\n<i>TCP latency · реальное время</i>\n\n<b>${start + 1}–${Math.min(start + pageLinks.length, links.length)}</b> из <b>${links.length}</b> · ${safePage + 1}/${totalPages}\n\n`;
  pageLinks.forEach((uri, i) => {
    const num = start + i + 1;
    const country = detectCountry(uri);
    const label = country ? `${country.flag} ${country.name}` : "🌍 Неизвестно";
    const r = results[i];
    const ping = r?.ok ? `<code>${r.ms} ms</code>` : `<code>timeout</code>`;
    const status = r?.ok ? "🟢" : "🔴";
    msg += `<b>${num}.</b> ${status} ${label} · ${protocolOf(uri)} · ${ping}\n`;
  });
  msg += `\n<i>🟢 = TCP connect успешен · число = latency до сервера</i>`;
  const navRow = [];
  if (safePage > 0) navRow.push({ text: "⬅️ Назад", callback_data: `list_page_${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: "Далее ➡️", callback_data: `list_page_${safePage + 1}` });
  const kb = { inline_keyboard: [] };
  if (navRow.length) kb.inline_keyboard.push(navRow);
  kb.inline_keyboard.push([{ text: "🔄 Обновить ping", callback_data: `list_page_${safePage}` }]);
  kb.inline_keyboard.push([{ text: "➕ Добавить", callback_data: "add_prompt" }, { text: "🧰 DEV", callback_data: "dev" }]);
  kb.inline_keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create или /decode`);
  const { subUrl: expSubUrl, pageUrl: expPageUrl } = userUrls(cfg, chatId);
  await sendMessage(cfg.telegramToken, chatId, `📤 <b>ЭКСПОРТ</b>\n\n🔗 <b>Ссылка подписки</b>\n<code>${expSubUrl}</code>\n\n📱 Совместимо с v2rayNG · Hiddify · Shadowrocket · Clash Meta`, { inline_keyboard: [[{ text: "🔗 Открыть подписку", url: expSubUrl }], [{ text: "🎨 Страница", url: expPageUrl }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Используй:</b> <code>/add vless://...</code>`);
  const userFile = `user_${chatId}.txt`;
  const existing = await getFileContent(cfg, userFile);
  if (!existing) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create`);
  const { headers, links } = splitSubscriptionFile(existing);
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) { const result = await decodeSubscription(url); if (result.ok && result.uris?.length) toAdd = result.uris; else return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось декодировать: ${result.error}`); }
  else if (!url.includes("://")) return sendMessage(cfg.telegramToken, chatId, `❌ Не похоже на VPN-ссылку.`);
  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, `Add ${toAdd.length} nodes`);
  if (res.content || res.sha) {
    const aliveFlags = await checkServersAlive(toAdd, { concurrency: 8, timeoutMs: 2000 });
    const aliveCount = aliveFlags.filter(Boolean).length;
    await sendMessage(cfg.telegramToken, chatId, `✅ <b>Сервер добавлен</b>\n\n📡 Добавлено: <code>${toAdd.length}</code>\n📊 Всего: <code>${links.length}</code>\n🟢 Рабочих: <code>${aliveCount}</code> · 🔴 Offline: <code>${toAdd.length - aliveCount}</code>`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }], [{ text: "➕ Добавить ещё", callback_data: "add_prompt" }, { text: "📋 Профиль", callback_data: "my" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  } else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка`);
}

export async function cmdDeleteServer(cfg, chatId, nRaw) {
  const n = parseInt(nRaw, 10);
  if (!Number.isInteger(n) || n < 1) return sendMessage(cfg.telegramToken, chatId, `❌ Укажи номер сервера: <code>/delete 3</code>`);
  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет`);
  const { headers, links } = splitSubscriptionFile(content);
  if (n > links.length) return sendMessage(cfg.telegramToken, chatId, `❌ Сервер №${n} не найден. Всего: ${links.length}`);
  const removed = links.splice(n - 1, 1)[0];
  const newContent = [...headers, ...links].join("\n");
  const res = await createOrUpdateFile(cfg, userFile, newContent, `Delete server ${n} for user ${chatId}`);
  if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Сервер №${n} удалён</b>\n\n${escapeHtml(removed.slice(0, 120))}`, { inline_keyboard: [[{ text: "📡 Список", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
  else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
}

export async function cmdReplaceServer(cfg, chatId, args) {
  const parts = args.trim().split(/\s+/);
  const n = parseInt(parts.shift(), 10);
  const newUrl = parts.join(" ");
  if (!Number.isInteger(n) || n < 1 || !newUrl) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Используй:</b>\n<code>/replace N vless://...</code>`);
  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет`);
  const { headers, links } = splitSubscriptionFile(content);
  if (n > links.length) return sendMessage(cfg.telegramToken, chatId, `❌ Сервер №${n} не найден. Всего: ${links.length}`);
  if (!newUrl.includes("://")) return sendMessage(cfg.telegramToken, chatId, `❌ Новая ссылка не похожа на VPN-конфигурацию.`);
  links[n - 1] = newUrl;
  const newContent = [...headers, ...links].join("\n");
  const res = await createOrUpdateFile(cfg, userFile, newContent, `Replace server ${n} for user ${chatId}`);
  if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `🔁 <b>Сервер №${n} заменён</b>\n\nТеперь: <code>${links.length}</code> серверов.`, { inline_keyboard: [[{ text: "📡 Проверить", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
  else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
}

export async function cmdDelete(cfg, chatId) {
  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет`);
  const res = await deleteFile(cfg, userFile, `Delete subscription for user ${chatId}`);
  if (res) await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Подписка удалена</b>\n\nМожно создать новую.`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }, { text: "🏠 Меню", callback_data: "menu" }]] });
  else await sendMessage(cfg.telegramToken, chatId, `❌ Не удалось удалить подписку`);
}

export async function cmdUsers(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, `👥 <b>Пользователи</b>\n\nВсего: <code>${users.length}</code>`, { inline_keyboard: [[{ text: "🧰 DEV Center", callback_data: "dev" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, `📊 <b>Статистика OceaniaVPN</b>\n\n👥 Пользователей: <code>${users.length}</code>\n📁 Профилей: <code>${users.length}</code>\n🧰 DEV-инструменты: <b>online</b>`, { inline_keyboard: [[{ text: "🧰 DEV Center", callback_data: "dev" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function handleCallback(cfg, cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from?.id || chatId;
  await answerCallback(cfg.telegramToken, cb.id);
  if (cb.data === "menu") await cmdStart(cfg, chatId);
  else if (cb.data === "tools") await sendMessage(cfg.telegramToken, chatId, `🧰 <b>Инструменты</b>\n\n📡 Серверы — ping и latency\n🔍 Декодер — импорт подписки\n📤 Экспорт — ссылки\n🌐 Прокси-подписка — общий каталог\n🎨 Оформление — темы`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }, { text: "🔍 Декодер", callback_data: "decode" }], [{ text: "🌐 Прокси", callback_data: "proxy" }, { text: "📤 Экспорт", callback_data: "export" }], [{ text: "🎨 Темы", callback_data: "theme_pick" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (cb.data === "proxy") await cmdProxy(cfg, chatId);
  else if (cb.data === "dev") await cmdDev(cfg, chatId, userId);
  else if (cb.data === "dev_ping") await cmdDevPing(cfg, chatId, userId);
  else if (cb.data === "dev_diag") await cmdDevDiag(cfg, chatId, userId);
  else if (cb.data === "dev_metrics") await cmdDevMetrics(cfg, chatId, userId);
  else if (cb.data === "create") { await setState(cfg, chatId, { step: "title" }); await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); }
  else if (cb.data === "decode") await sendMessage(cfg.telegramToken, chatId, `🔍 <b>Декодер</b>\n\nОтправь URL подписки или используй:\n<code>/decode https://...</code>\n\nПоддержка: YAML · JSON · Base64 · URI · Happ/INCY/V2RayTun`, { inline_keyboard: [[{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (cb.data === "my") await cmdMy(cfg, chatId);
  else if (cb.data === "list") await cmdList(cfg, chatId, 0);
  else if (cb.data.indexOf("list_page_") === 0) { const page = parseInt(cb.data.substring("list_page_".length), 10) || 0; await cmdList(cfg, chatId, page); }
  else if (cb.data === "delsrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Удаление</b>\n\n<code>/delete N</code>`);
  else if (cb.data === "replacesrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🔁 <b>Замена</b>\n\n<code>/replace N vless://...</code>`);
  else if (cb.data === "add_prompt") await sendMessage(cfg.telegramToken, chatId, `➕ <b>Добавить сервер</b>\n\nОтправь VLESS/VMess/Trojan/SS или URL подписки.`, { inline_keyboard: [[{ text: "📋 Профиль", callback_data: "my" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (cb.data === "export") await cmdExport(cfg, chatId);
  else if (cb.data === "theme_pick") {
    const { pageUrl } = userUrls(cfg, chatId);
    const themeUrl = (themeId = null) => { try { const u = new URL(pageUrl); if (themeId) u.searchParams.set("theme", themeId); return u.toString(); } catch { return pageUrl; } };
    const kb = { inline_keyboard: [] };
    for (let i = 0; i < THEME_LIST.length; i += 2) kb.inline_keyboard.push(THEME_LIST.slice(i, i + 2).map(t => ({ text: t.label, url: themeUrl(t.id) })));
    kb.inline_keyboard.push([{ text: "🎲 Случайная тема", url: themeUrl() }], [{ text: "🏠 Меню", callback_data: "menu" }]);
    await sendMessage(cfg.telegramToken, chatId, `🎨 <b>Оформление</b>\n\nВыбери тему страницы подписки.`, kb);
  }
  else if (cb.data === "delete") await sendMessage(cfg.telegramToken, chatId, `⚠️ <b>Удалить подписку?</b>\n\nСерверы можно будет добавить заново.`, { inline_keyboard: [[{ text: "🗑 Да, удалить", callback_data: "delete_confirm" }], [{ text: "↩️ Отмена", callback_data: "my" }]] });
  else if (cb.data === "delete_confirm") await cmdDelete(cfg, chatId);
  else if (cb.data === "save_alive") { const cached = await cfg.kv.get(`pingcache_${chatId}`, "json"); if (!cached || !cached.uris?.length) await sendMessage(cfg.telegramToken, chatId, `⌛ <b>Кэш устарел</b>\n\nЗапусти /decode заново.`); else { const userFile = `user_${chatId}.txt`; const content = buildFile({ title: cached.title, interval: 4 }, cached.uris); const res = await createOrUpdateFile(cfg, userFile, content, `Save ${cached.uris.length} alive servers`); if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `✅ <b>Подписка сохранена</b>\n\n🟢 Серверов: <code>${cached.uris.length}</code>`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }], [{ text: "🏠 Меню", callback_data: "menu" }]] }); else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`); } }
  else if (cb.data === "help") await cmdHelp(cfg, chatId);
}

export async function handleMessage(cfg, msg) {
  if (msg.document) return handleProxyDocument(cfg, msg);
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const state = await getState(cfg, chatId);
  if (state && state.step && !text.startsWith("/")) { await handleStepAnswer(cfg, chatId, text, state); return; }
  if (!text.startsWith("/") && /^https?:\/\//.test(text.trim())) { await cmdDecode(cfg, chatId, text.trim()); return; }
  if (!text.startsWith("/")) return;
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const userId = msg.from.id;
  if (cmd === "/start") return cmdStart(cfg, chatId);
  if (cmd === "/help") return cmdHelp(cfg, chatId);
  if (cmd === "/create") return cmdCreate(cfg, chatId);
  if (cmd === "/decode") return cmdDecode(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/my") return cmdMy(cfg, chatId);
  if (cmd === "/list") return cmdList(cfg, chatId, parts[1] ? (parseInt(parts[1], 10) - 1) : 0);
  if (cmd === "/export") return cmdExport(cfg, chatId);
  if (cmd === "/proxy") return cmdProxy(cfg, chatId);
  if (cmd === "/add") return cmdAdd(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/replace") return cmdReplaceServer(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/delete") { if (parts.length > 1) return cmdDeleteServer(cfg, chatId, parts[1]); return cmdDelete(cfg, chatId); }
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
  if (cmd === "/dev") return cmdDev(cfg, chatId, userId);
}