import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription, checkServersAlive } from "./decoder.js";
import { pingServers, cmdDev, cmdDevPing, cmdDevDiag, cmdDevMetrics } from "./devtools.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";
import { listSubscriptionDevices, clearSubscriptionDevices } from "./devices.js";
import { COUNTRIES, matchesCountryKey, detectCountryFromText } from "./contries.js";
import { cmdProxy, addProxyLink } from "./proxy.js";
import { listSubscriptions, getActiveSubscription, getActiveFilename, createSubscription, setActiveSubscription, deleteSubscriptionRecord } from "./subscriptions.js";

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
  const hashIndex = uri.lastIndexOf("#");
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

async function userUrls(cfg, chatId) {
  const active = await getActiveSubscription(cfg, chatId);
  const suffix = active?.id ? `&s=${encodeURIComponent(active.id)}` : "";
  return {
    subUrl: `${cfg.workerOrigin}/sub?u=${chatId}${suffix}`,
    pageUrl: `${cfg.workerOrigin}/page?u=${chatId}${suffix}`,
  };
}

function isTelegramProxyLink(value) {
  const raw = String(value || "").trim();
  if (/^tg:\/\/proxy\?/i.test(raw)) return true;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" &&
      (host === "t.me" || host === "telegram.me" || host === "www.t.me" || host === "www.telegram.me") &&
      u.pathname === "/proxy";
  } catch {
    return false;
  }
}

function mainMenu(isAdmin = false) {
  const rows = [
    [{ text: "🚀  Создать подписку", callback_data: "create" }],
    [{ text: "📋  Мои подписки", callback_data: "subs" }, { text: "📡  Серверы", callback_data: "list" }],
    [{ text: "📱  Устройства", callback_data: "devices" }],
    [{ text: "🌐  Прокси-подписка", callback_data: "proxy" }],
    [{ text: "🔍  Декодер", callback_data: "decode" }, { text: "📤  Экспорт", callback_data: "export" }],
    [{ text: "⚡  Полезные функции", callback_data: "features" }],
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
  try {
    const subscription = await createSubscription(cfg, chatId, { title: state.title || "Моя подписка" });
    const content = buildFile(state, uris);
    const res = await createOrUpdateFile(cfg, subscription.filename, content, `Create subscription ${subscription.id} for user ${chatId}`);
    if (res.content || res.sha) {
      const { subUrl, pageUrl } = await userUrls(cfg, chatId);
      const kb = { inline_keyboard: [
        [{ text: "📋 Моя подписка", callback_data: "my" }, { text: "🔀 Все подписки", callback_data: "subs" }],
        [{ text: "🎨 Страница подписки", url: pageUrl }, { text: "🖼 Сменить тему", callback_data: "theme_pick" }],
        [{ text: "📡 Список серверов", callback_data: "list" }],
        [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }],
        [{ text: "🗑 Удалить подписку", callback_data: "delete" }],
      ] };
      await sendMessage(cfg.telegramToken, chatId,
        `✅ <b>Подписка создана</b>\n\n━━━━━━━━━━━━━━━━━━━━\n🏷 Название: <b>${escapeHtml(subscription.title)}</b>\n📡 Серверов: <code>${uris.length}</code>\n🔗 Ссылка:\n<code>${subUrl}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 Можно иметь несколько подписок и переключаться между ними через «🔀 Все подписки».`, kb);
    } else {
      await deleteSubscriptionRecord(cfg, chatId, subscription.id);
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
    }
  } catch (error) {
    await sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось создать подписку.</b>\n\n<code>${escapeHtml(error.message || String(error))}</code>`);
  } finally {
    await clearState(cfg, chatId);
  }
}

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
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
    `Создаём профиль, проверяем серверы, декодируем подписки или открываем полезные функции.`,
    mainMenu(admin));
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(cfg.telegramToken, chatId,
    `ℹ️ <b>OCEANIA VPN · Справка</b>\n\n` +
    `<b>Основное</b>\n/start · главное меню\n/create · создать подписку\n/my · активная подписка\n/subs · все подписки и переключение\n/list · серверы + проверка\n/add · добавить сервер/подписку\n/replace N · заменить сервер\n/delete N · удалить сервер\n/export · ссылки\n/decode URL · декодировать\n/proxy · прокси-подписки\n\n` +
    `<b>Полезные функции</b>\n/check · проверить серверы\n/best · найти самый быстрый сервер\n/clean · удалить дубли\n/analytics · аналитика профиля\n/share · поделиться подпиской\n/cancel · отменить операцию\n\n` +
    `<b>Для разработчика</b>\n/users · пользователи\n/stats · статистика\n/dev · DEV Control Center\n\n` +
    `<b>Декодер</b>\nYAML · JSON · Base64 · URI · Happ/INCY/V2RayTun redirect · вложенные ссылки\n\n` +
    `<b>Мониторинг</b>\nTCP latency в миллисекундах и проверка доступности серверов.`,
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
  if (isTelegramProxyLink(inputUrl)) return addProxyLink(cfg, chatId, inputUrl);
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
      const errorMsg = `❌ <b>Не удалось расшифровать</b>\n\n${escapeHtml(result.error || "Неизвестная ошибка")}`;
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
      const errorMsg = `❌ <b>Ошибка сохранения</b>\n\n${escapeHtml(res.message || "неизвестно")}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }
    const rawUrl = `${cfg.workerOrigin}/sub?f=${encodeURIComponent(filename)}`;
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, hysteria: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++; else if (u.startsWith("vmess://")) stats.vmess++; else if (u.startsWith("trojan://")) stats.trojan++; else if (u.startsWith("ss://")) stats.ss++; else if (u.startsWith("hysteria")) stats.hysteria++; else stats.other++;
    }
    const kb = { inline_keyboard: [[{ text: "📋 Открыть подписку", url: rawUrl }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] };
    const successMsg = `✅ <b>Подписка расшифрована</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 Серверов: <code>${uris.length}</code>\n🔌 VLESS <b>${stats.vless}</b> · VMess <b>${stats.vmess}</b>\n🔌 Trojan <b>${stats.trojan}</b> · SS <b>${stats.ss}</b>\n🔌 Hysteria <b>${stats.hysteria}</b> · Other <b>${stats.other}</b>\n━━━━━━━━━━━━━━━━━━━━\n🔗 <code>${escapeHtml(rawUrl)}</code>`;
    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb); else await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
  } catch (err) {
    const errorMsg = `⚠️ <b>Ошибка декодирования</b>\n\n<code>${escapeHtml(err.message)}</code>`;
    if (loadingMsgId) { try { await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); } catch { await sendMessage(cfg.telegramToken, chatId, errorMsg); } } else await sendMessage(cfg.telegramToken, chatId, errorMsg);
  }
}

export async function cmdSubscriptions(cfg, chatId) {
  const items = await listSubscriptions(cfg, chatId);
  const active = await getActiveSubscription(cfg, chatId);
  if (!items.length) {
    return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписок пока нет.</b>`, { inline_keyboard: [[{ text: "🚀 Создать подписку", callback_data: "create" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }

  const rows = items.map((item, index) => [
    { text: `${item.id === active?.id ? "🟢" : "⚪️"} ${index + 1}. ${item.title || "Моя подписка"}`, callback_data: `sub_switch_${item.id}` }
  ]);
  rows.push([{ text: "➕ Создать ещё", callback_data: "create" }]);
  rows.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);

  await sendMessage(cfg.telegramToken, chatId,
    `🔀 <b>МОИ ПОДПИСКИ</b>\n\nВсего: <code>${items.length}</code>\n🟢 Выбрана: <b>${escapeHtml(active?.title || "—")}</b>\n\nНажми на подписку, чтобы сделать её активной для кнопок «Серверы», «Экспорт», «Проверка» и ссылки.`,
    { inline_keyboard: rows });
}

export async function cmdSwitchSubscription(cfg, chatId, id) {
  const item = await setActiveSubscription(cfg, chatId, id);
  if (!item) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Подписка не найдена.</b>`, { inline_keyboard: [[{ text: "🔀 Все подписки", callback_data: "subs" }]] });
  const { subUrl } = await userUrls(cfg, chatId);
  await sendMessage(cfg.telegramToken, chatId,
    `🟢 <b>Подписка выбрана</b>\n\n🏷 ${escapeHtml(item.title)}\n🔗 <code>${escapeHtml(subUrl)}</code>`,
    { inline_keyboard: [[{ text: "📋 Открыть", callback_data: "my" }], [{ text: "🔀 Все подписки", callback_data: "subs" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписка ещё не создана</b>\n\nСоздай профиль или импортируй URL.`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }, { text: "🔍 Декодировать", callback_data: "decode" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const { headers, links } = splitSubscriptionFile(content);
  const { pageUrl } = await userUrls(cfg, chatId);
  const msg = `📋 <b>МОЙ ПРОФИЛЬ</b>\n\n🟢 Статус: <b>АКТИВЕН</b>\n📡 Серверов: <code>${links.length}</code>\n\n<b>Параметры</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>`;
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🎨 Страница", url: pageUrl }, { text: "🖼 Тема", callback_data: "theme_pick" }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "📤 Экспорт", callback_data: "export" }],\n    [{ text: "🔀 Все подписки", callback_data: "subs" }], [{ text: "⚡ Проверка", callback_data: "check" }, { text: "📊 Аналитика", callback_data: "analytics" }], [{ text: "🗑 Удалить", callback_data: "delete" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdList(cfg, chatId, page = 0) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет серверов</b>`);
  const { links } = splitSubscriptionFile(content);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(links.length / pageSize));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * pageSize;
  const slice = links.slice(start, start + pageSize);
  let text = `📡 <b>СЕРВЕРЫ</b>\n\n`;
  if (!slice.length) text += `Список пуст.`;
  else slice.forEach((u, i) => { text += `${start + i + 1}. <code>${escapeHtml(u)}</code>\n`; });
  const kb = [];
  if (page > 0) kb.push([{ text: "⬅️", callback_data: `list_page_${page - 1}` }]);
  if (page < totalPages - 1) { if (kb.length) kb[0].push({ text: "➡️", callback_data: `list_page_${page + 1}` }); else kb.push([{ text: "➡️", callback_data: `list_page_${page + 1}` }]); }
  kb.push([{ text: "⚡ Проверить", callback_data: "check" }, { text: "🏆 Лучший", callback_data: "best" }]);
  kb.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  await sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: kb });
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет подписки</b>`);
  const { subUrl, pageUrl } = await userUrls(cfg, chatId);
  await sendMessage(cfg.telegramToken, chatId, `📤 <b>ЭКСПОРТ</b>\n\n🔗 Подписка:\n<code>${escapeHtml(subUrl)}</code>\n\n🎨 Страница:\n<code>${escapeHtml(pageUrl)}</code>`, { inline_keyboard: [[{ text: "📋 Подписка", url: subUrl }, { text: "🎨 Страница", url: pageUrl }], [{ text: "📤 Поделиться", callback_data: "share" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdAdd(cfg, chatId, value) {
  const text = String(value || "").trim();
  if (!text) return sendMessage(cfg.telegramToken, chatId, `➕ <b>Добавление</b>\n\nОтправь VLESS/VMess/Trojan/SS или URL подписки.`);
  if (isTelegramProxyLink(text)) return addProxyLink(cfg, chatId, text);
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  const lines = content ? splitSubscriptionFile(content).links : [];
  if (/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(text)) {
    lines.push(text);
    const oldHeaders = content ? splitSubscriptionFile(content).headers : [];
    const newContent = [...oldHeaders, ...lines].join("\n");
    const res = await createOrUpdateFile(cfg, await getActiveFilename(cfg, chatId), newContent, `Add server for ${chatId}`);
    if (res.content || res.sha) return sendMessage(cfg.telegramToken, chatId, `✅ <b>Сервер добавлен.</b>\n\n📡 Всего: <code>${lines.length}</code>`, { inline_keyboard: [[{ text: "📡 Список", callback_data: "list" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
    return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось сохранить сервер.`);
  }
  return cmdDecode(cfg, chatId, text);
}

function parseServerIndex(value) {
  const raw = String(value || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const idx = Number(raw);
  return Number.isSafeInteger(idx) && idx >= 1 ? idx : null;
}

function isSupportedServerUri(value) {
  return /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\/\S+$/i.test(String(value || "").trim());
}

export async function cmdReplaceServer(cfg, chatId, value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d+)\s+(.+)$/s);
  const idx = parseServerIndex(match?.[1]);
  const uri = match?.[2]?.trim() || "";
  if (!idx || !uri || !isSupportedServerUri(uri)) {
    return sendMessage(cfg.telegramToken, chatId, `❌ <b>Неверный формат</b>\n\nИспользуй:\n<code>/replace 2 vless://...</code>\n\nПоддерживаются VLESS, VMess, Trojan, SS и Hysteria.`);
  }
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет подписки.</b>`);
  const parsed = splitSubscriptionFile(content);
  if (idx > parsed.links.length) return sendMessage(cfg.telegramToken, chatId, `❌ Сервер №${idx} не найден.\n\nВ подписке серверов: <code>${parsed.links.length}</code>`);
  parsed.links[idx - 1] = uri;
  const newContent = [...parsed.headers, ...parsed.links].join("\n");
  const res = await createOrUpdateFile(cfg, await getActiveFilename(cfg, chatId), newContent, `Replace server ${idx} for ${chatId}`);
  if (res.content || res.sha) {
    return sendMessage(cfg.telegramToken, chatId, `✅ <b>Сервер №${idx} заменён.</b>\n\nНовый сервер сохранён в подписке.`, { inline_keyboard: [[{ text: "📡 Список серверов", callback_data: "list" }], [{ text: "📋 Моя подписка", callback_data: "my" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }
  return sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось сохранить изменения.</b>`);
}

export async function cmdDeleteServer(cfg, chatId, n) {
  const idx = parseServerIndex(n);
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет подписки.</b>`);
  const parsed = splitSubscriptionFile(content);
  if (!idx || idx > parsed.links.length) return sendMessage(cfg.telegramToken, chatId, `❌ Сервер не найден.`);
  parsed.links.splice(idx - 1, 1);
  const newContent = [...parsed.headers, ...parsed.links].join("\n");
  const res = await createOrUpdateFile(cfg, await getActiveFilename(cfg, chatId), newContent, `Delete server ${idx} for ${chatId}`);
  if (res.content || res.sha) return sendMessage(cfg.telegramToken, chatId, `✅ <b>Сервер №${idx} удалён.</b>`);
  return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось сохранить изменения.`);
}

export async function cmdDelete(cfg, chatId) {
  const active = await getActiveSubscription(cfg, chatId);
  if (!active) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет подписок.</b>`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }]] });
  const res = await deleteFile(cfg, active.filename, `Delete subscription ${active.id} for ${chatId}`);
  if (res.content || res.sha) {
    await deleteSubscriptionRecord(cfg, chatId, active.id);
    await clearSubscriptionDevices(cfg.kv, chatId);
    const remaining = await listSubscriptions(cfg, chatId);
    return sendMessage(cfg.telegramToken, chatId,
      `🗑 <b>Подписка «${escapeHtml(active.title)}» удалена.</b>\n\nОсталось подписок: <code>${remaining.length}</code>`,
      { inline_keyboard: remaining.length
        ? [[{ text: "🔀 Выбрать подписку", callback_data: "subs" }], [{ text: "🚀 Создать новую", callback_data: "create" }], [{ text: "🏠 Меню", callback_data: "menu" }]]
        : [[{ text: "🚀 Создать подписку", callback_data: "create" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }
  return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось удалить подписку.`);
}

async function getUserLinks(cfg, chatId) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  return content ? splitSubscriptionFile(content) : { headers: [], links: [] };
}

export async function cmdCheck(cfg, chatId) {
  const { links } = await getUserLinks(cfg, chatId);
  if (!links.length) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет серверов для проверки.</b>\n\nДобавь сервер или импортируй подписку.`, backToMenuKeyboard());
  const limited = links.slice(0, 40);
  await sendMessage(cfg.telegramToken, chatId, `⏳ <b>Проверяю серверы…</b>\n\n📡 Проверяю до 40 серверов с TCP timeout 2.5 сек.`);
  const results = await pingServers(limited, { concurrency: 6, timeoutMs: 2500 });
  const alive = results.filter(r => r?.ok);
  const times = alive.map(r => r.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const best = times.length ? times[0] : null;
  let text = `⚡ <b>ПРОВЕРКА СЕРВЕРОВ</b>\n\n` +
    `🟢 Онлайн: <b>${alive.length}</b> / ${limited.length}\n` +
    `🔴 Offline: <b>${limited.length - alive.length}</b>\n` +
    `📊 Средний ping: <b>${avg === null ? "—" : avg + " ms"}</b>\n` +
    `🏆 Лучший: <b>${best === undefined ? "—" : best + " ms"}</b>\n\n`;
  results.slice(0, 20).forEach((r, i) => {
    text += `${r?.ok ? "🟢" : "🔴"} <b>${i + 1}.</b> ${protocolOf(limited[i])} · <code>${r?.ok ? r.ms + " ms" : "timeout"}</code>\n`;
  });
  if (limited.length < links.length) text += `\n<i>Показаны первые ${limited.length} из ${links.length}.</i>`;
  await sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: [[{ text: "🔄 Проверить снова", callback_data: "check" }, { text: "🏆 Лучший", callback_data: "best" }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdBest(cfg, chatId) {
  const { links } = await getUserLinks(cfg, chatId);
  if (!links.length) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет серверов.</b>`, backToMenuKeyboard());
  const limited = links.slice(0, 40);
  await sendMessage(cfg.telegramToken, chatId, `⏳ <b>Ищу самый быстрый сервер…</b>`);
  const results = await pingServers(limited, { concurrency: 6, timeoutMs: 2500 });
  let bestIndex = -1;
  let bestMs = Infinity;
  for (let i = 0; i < results.length; i++) {
    if (results[i]?.ok && results[i].ms < bestMs) { bestMs = results[i].ms; bestIndex = i; }
  }
  if (bestIndex === -1) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Не найдено доступных серверов.</b>\n\nПопробуй проверить подписку позже.`, { inline_keyboard: [[{ text: "🔄 Повторить", callback_data: "best" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const uri = limited[bestIndex];
  await sendMessage(cfg.telegramToken, chatId,
    `🏆 <b>САМЫЙ БЫСТРЫЙ СЕРВЕР</b>\n\n` +
    `🥇 №${bestIndex + 1}\n⚡ TCP latency: <b>${bestMs} ms</b>\n🔌 Протокол: <b>${escapeHtml(protocolOf(uri))}</b>\n\n<code>${escapeHtml(uri)}</code>`,
    { inline_keyboard: [[{ text: "🔄 Найти заново", callback_data: "best" }], [{ text: "📡 Список", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdClean(cfg, chatId) {
  const { headers, links } = await getUserLinks(cfg, chatId);
  if (!links.length) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет серверов для очистки.</b>`, backToMenuKeyboard());
  const unique = [...new Set(links)];
  const removed = links.length - unique.length;
  if (!removed) return sendMessage(cfg.telegramToken, chatId, `✨ <b>Дубликатов нет.</b>\n\n📡 Серверов: <code>${links.length}</code>`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const content = [...headers, ...unique].join("\n");
  const res = await createOrUpdateFile(cfg, await getActiveFilename(cfg, chatId), content, `Remove ${removed} duplicate servers for ${chatId}`);
  if (!(res.content || res.sha)) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось сохранить очистку.</b>`);
  await sendMessage(cfg.telegramToken, chatId, `🧹 <b>Готово!</b>\n\nУдалено дублей: <code>${removed}</code>\nОсталось серверов: <code>${unique.length}</code>`, { inline_keyboard: [[{ text: "📡 Список", callback_data: "list" }], [{ text: "⚡ Проверить", callback_data: "check" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdDevices(cfg, chatId) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) {
    return sendMessage(
      cfg.telegramToken,
      chatId,
      `📱 <b>УСТРОЙСТВА</b>\n\nПодписка не создана.`,
      { inline_keyboard: [[{ text: "🚀 Создать подписку", callback_data: "create" }], [{ text: "🏠 Меню", callback_data: "menu" }]] }
    );
  }

  const devices = await listSubscriptionDevices(cfg.kv, chatId);

  if (!devices.length) {
    return sendMessage(
      cfg.telegramToken,
      chatId,
      `📱 <b>УСТРОЙСТВА</b>\n\n<b>0 устройств</b>\n\nОткрой подписку в VPN-клиенте, затем нажми «Обновить».`,
      { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "devices" }], [{ text: "🏠 Меню", callback_data: "menu" }]] }
    );
  }

  const formatSeen = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  let text = `📱 <b>УСТРОЙСТВА</b>\n\n<b>${devices.length} ${devices.length === 1 ? "устройство" : devices.length < 5 ? "устройства" : "устройств"}</b>\n\n`;

  devices.forEach((device, index) => {
    const icon = device.type === "Tablet" ? "📱" : "📲";
    text += `${icon} <b>${escapeHtml(device.name || device.id || "Неизвестное устройство")}</b>\n`;
    text += `<code>${escapeHtml(device.brand || "—")}</code> · <code>${escapeHtml(device.os || "—")}</code>\n`;
    text += `🕒 ${escapeHtml(formatSeen(device.lastSeen))}`;
    if (index < devices.length - 1) text += "\n\n";
  });

  await sendMessage(cfg.telegramToken, chatId, text, {
    inline_keyboard: [
      [{ text: "🔄 Обновить", callback_data: "devices" }],
      [{ text: "📋 Подписка", callback_data: "my" }, { text: "🏠 Меню", callback_data: "menu" }]
    ]
  });
}

export async function cmdAnalytics(cfg, chatId) {
  const { links } = await getUserLinks(cfg, chatId);
  if (!links.length) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет данных для аналитики.</b>`, backToMenuKeyboard());
  const protocols = {};
  const countries = {};
  for (const uri of links) {
    const protocol = protocolOf(uri);
    protocols[protocol] = (protocols[protocol] || 0) + 1;
    const country = detectCountry(uri);
    const name = country?.name || "🌍 Рандом";
    countries[name] = (countries[name] || 0) + 1;
  }
  const protocolText = Object.entries(protocols).sort((a, b) => b[1] - a[1]).map(([k, v]) => `🔌 ${escapeHtml(k)}: <b>${v}</b>`).join("\n");
  const countryText = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `• ${escapeHtml(k)} — <b>${v}</b>`).join("\n");
  await sendMessage(cfg.telegramToken, chatId, `📊 <b>АНАЛИТИКА ПРОФИЛЯ</b>\n\n📡 Всего серверов: <b>${links.length}</b>\n\n<b>Протоколы</b>\n${protocolText || "нет данных"}\n\n<b>Страны</b>\n${countryText || "нет данных"}`, { inline_keyboard: [[{ text: "⚡ Проверка", callback_data: "check" }, { text: "🏆 Лучший", callback_data: "best" }], [{ text: "🧹 Убрать дубли", callback_data: "clean" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

export async function cmdShare(cfg, chatId) {
  const content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Нет подписки для отправки.</b>`, backToMenuKeyboard());
  const { subUrl, pageUrl } = await userUrls(cfg, chatId);
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(subUrl)}&text=${encodeURIComponent("Моя подписка OceaniaVPN")}`;
  await sendMessage(cfg.telegramToken, chatId, `🔗 <b>ПОДЕЛИТЬСЯ ПОДПИСКОЙ</b>\n\nСсылка на подписку:\n<code>${escapeHtml(subUrl)}</code>\n\nСтраница:\n<code>${escapeHtml(pageUrl)}</code>`, { inline_keyboard: [[{ text: "📤 Поделиться в Telegram", url: shareUrl }], [{ text: "📋 Открыть подписку", url: subUrl }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
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

export async function handleCallback(cfg, cb, options = {}) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id || chatId;

  // Обычные callback-кнопки из сообщений бота всегда содержат message.
  // Если Telegram прислал inline callback без message, нельзя выдумывать chat_id.
  if (!chatId) {
    console.warn("[Callback] Missing message.chat.id:", {
      id: cb?.id,
      data: cb?.data,
      inlineMessageId: cb?.inline_message_id,
    });
    return;
  }

  if (!options.callbackAlreadyAnswered) {
    await answerCallback(cfg.telegramToken, cb.id);
  }

  const data = String(cb.data || "").trim();
  if (!data) {
    console.warn("[Callback] Empty callback_data");
    return;
  }
  if (data === "menu") await cmdStart(cfg, chatId);
  else if (data === "features") await sendMessage(cfg.telegramToken, chatId, `⚡ <b>ПОЛЕЗНЫЕ ФУНКЦИИ</b>\n\nПять быстрых инструментов для любого пользователя:`, { inline_keyboard: [[{ text: "⚡ Проверить серверы", callback_data: "check" }], [{ text: "🏆 Найти лучший", callback_data: "best" }], [{ text: "🧹 Убрать дубли", callback_data: "clean" }], [{ text: "📊 Аналитика", callback_data: "analytics" }], [{ text: "📤 Поделиться", callback_data: "share" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  else if (data === "check") await cmdCheck(cfg, chatId);
  else if (data === "best") await cmdBest(cfg, chatId);
  else if (data === "clean") await cmdClean(cfg, chatId);
  else if (data === "analytics") await cmdAnalytics(cfg, chatId);
  else if (data === "devices") await cmdDevices(cfg, chatId);
  else if (data === "share") await cmdShare(cfg, chatId);
  else if (data === "tools") await sendMessage(cfg.telegramToken, chatId, `🧰 <b>Инструменты</b>\n\n📡 Серверы — ping и latency\n🔍 Декодер — импорт подписки\n📤 Экспорт — ссылки\n🌐 Прокси-подписка — общий каталог\n🎨 Оформление — темы\n⚡ Полезные функции — проверка, лучший сервер, очистка, аналитика, шаринг`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }, { text: "🔍 Декодер", callback_data: "decode" }], [{ text: "🌐 Прокси", callback_data: "proxy" }, { text: "📤 Экспорт", callback_data: "export" }], [{ text: "⚡ Функции", callback_data: "features" }], [{ text: "🎨 Темы", callback_data: "theme_pick" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (data === "proxy") await cmdProxy(cfg, chatId);
  else if (data === "dev") await cmdDev(cfg, chatId, userId);
  else if (data === "dev_ping") await cmdDevPing(cfg, chatId, userId);
  else if (data === "dev_diag") await cmdDevDiag(cfg, chatId, userId);
  else if (data === "dev_metrics") await cmdDevMetrics(cfg, chatId, userId);
  else if (data === "create") { await setState(cfg, chatId, { step: "title" }); await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); }
  else if (data === "decode") await sendMessage(cfg.telegramToken, chatId, `🔍 <b>Декодер</b>\n\nОтправь URL подписки или используй:\n<code>/decode https://...</code>\n\nПоддержка: YAML · JSON · Base64 · URI · Happ/INCY/V2RayTun`, { inline_keyboard: [[{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (data === "my") await cmdMy(cfg, chatId);
  else if (data === "subs") await cmdSubscriptions(cfg, chatId);
  else if (data.startsWith("sub_switch_")) await cmdSwitchSubscription(cfg, chatId, data.substring("sub_switch_".length));
  else if (data === "list") await cmdList(cfg, chatId, 0);
  else if (data.indexOf("list_page_") === 0) { const page = parseInt(data.substring("list_page_".length), 10) || 0; await cmdList(cfg, chatId, page); }
  else if (data === "delsrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Удаление</b>\n\n<code>/delete N</code>`);
  else if (data === "replacesrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🔁 <b>Замена</b>\n\n<code>/replace N vless://...</code>`);
  else if (data === "add_prompt") await sendMessage(cfg.telegramToken, chatId, `➕ <b>Добавить сервер</b>\n\nОтправь VLESS/VMess/Trojan/SS или URL подписки.`, { inline_keyboard: [[{ text: "📋 Профиль", callback_data: "my" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (data === "export") await cmdExport(cfg, chatId);
  else if (data === "theme_pick") {
    const { pageUrl } = await userUrls(cfg, chatId);
    const themeUrl = (themeId = null) => { try { const u = new URL(pageUrl); if (themeId) u.searchParams.set("theme", themeId); return u.toString(); } catch { return pageUrl; } };
    const kb = { inline_keyboard: [] };
    for (let i = 0; i < THEME_LIST.length; i += 2) kb.inline_keyboard.push(THEME_LIST.slice(i, i + 2).map(t => ({ text: t.label, url: themeUrl(t.id) })));
    kb.inline_keyboard.push([{ text: "🎲 Случайная тема", url: themeUrl() }], [{ text: "🏠 Меню", callback_data: "menu" }]);
    await sendMessage(cfg.telegramToken, chatId, `🎨 <b>Оформление</b>\n\nВыбери тему страницы подписки.`, kb);
  }
  else if (data === "delete") await sendMessage(cfg.telegramToken, chatId, `⚠️ <b>Удалить подписку?</b>\n\nСерверы можно будет добавить заново.`, { inline_keyboard: [[{ text: "🗑 Да, удалить", callback_data: "delete_confirm" }], [{ text: "↩️ Отмена", callback_data: "my" }]] });
  else if (data === "delete_confirm") await cmdDelete(cfg, chatId);
  else if (data === "save_alive") { const cached = await cfg.kv.get(`pingcache_${chatId}`, "json"); if (!cached || !cached.uris?.length) await sendMessage(cfg.telegramToken, chatId, `⌛ <b>Кэш устарел</b>\n\nЗапусти /decode заново.`); else { const userFile = await getActiveFilename(cfg, chatId); const content = buildFile({ title: cached.title, interval: 4 }, cached.uris); const res = await createOrUpdateFile(cfg, userFile, content, `Save ${cached.uris.length} alive servers`); if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `✅ <b>Подписка сохранена</b>\n\n🟢 Серверов: <code>${cached.uris.length}</code>`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }], [{ text: "🏠 Меню", callback_data: "menu" }]] }); else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`); } }
  else if (data === "help") await cmdHelp(cfg, chatId);
  else {
    console.warn("[Callback] Unknown callback_data:", data);
    await sendMessage(cfg.telegramToken, chatId, `⚠️ <b>Кнопка устарела.</b>\\n\\nОткрой меню заново.`, { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  }
}

export async function handleMessage(cfg, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  if (text.trim() && isTelegramProxyLink(text.trim())) return addProxyLink(cfg, chatId, text.trim());
  if (msg.document) return sendMessage(cfg.telegramToken, chatId, `⛔️ <b>Для прокси теперь отправляется именно ссылка Telegram-прокси.</b>\n\nОткрой раздел «🌐 Прокси-подписка» и просто пришли ссылку.`);
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
  if (cmd === "/subs") return cmdSubscriptions(cfg, chatId);
  if (cmd === "/list") return cmdList(cfg, chatId, parts[1] ? (parseInt(parts[1], 10) - 1) : 0);
  if (cmd === "/export") return cmdExport(cfg, chatId);
  if (cmd === "/proxy") return cmdProxy(cfg, chatId);
  if (cmd === "/check") return cmdCheck(cfg, chatId);
  if (cmd === "/best") return cmdBest(cfg, chatId);
  if (cmd === "/clean") return cmdClean(cfg, chatId);
  if (cmd === "/analytics") return cmdAnalytics(cfg, chatId);
  if (cmd === "/share") return cmdShare(cfg, chatId);
  if (cmd === "/add") return cmdAdd(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/replace") return cmdReplaceServer(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/delete") { if (parts.length > 1) return cmdDeleteServer(cfg, chatId, parts[1]); return cmdDelete(cfg, chatId); }
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
  if (cmd === "/dev") return cmdDev(cfg, chatId, userId);
}
