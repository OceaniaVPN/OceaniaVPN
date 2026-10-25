import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription, checkServersAlive } from "./decoder.js";
import { decryptCrypt5 } from "./crypt5.js";
import { pingServers, cmdDev, cmdDevPing, cmdDevDiag, cmdDevMetrics } from "./devtools.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";
import { COUNTRIES, matchesCountryKey, detectCountryFromText } from "./contries.js";
import { cmdProxy, addProxyLink } from "./proxy.js";
import { HTTP_PROXY_COUNTRIES, checkCountryProxies, checkProxyTcp, isKnownHttpProxyEndpoint } from "./proxy-check.js";
import { getProxyPreference, getActiveProxyPreference, setProxyPreference, getLastDecodedProfile, setLastDecodedProfile } from "./proxy-preferences.js";
import { listSubscriptions, getActiveSubscription, getActiveFilename, createSubscription, setActiveSubscription, deleteSubscriptionRecord, updateSubscriptionSettings, makeSubscriptionDeviceKey } from "./subscriptions.js";
import { listScheduledChanges, addScheduledChange, cancelScheduledChange } from "./scheduler.js";

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

async function platformSubscriptionUrl(cfg, chatId, platform) {
  const active = await getActiveSubscription(cfg, chatId);
  const base = `${cfg.workerOrigin}/sub?u=${encodeURIComponent(chatId)}`;
  if (active?.id) {
    return `${base}&s=${encodeURIComponent(active.id)}&p=${encodeURIComponent(platform)}`;
  }
  const decodedFilename = await getLastDecodedProfile(cfg, chatId);
  if (decodedFilename) {
    return `${base}&f=${encodeURIComponent(decodedFilename)}&p=${encodeURIComponent(platform)}`;
  }
  return null;
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
    [{ text: "📝  Черновики", callback_data: "schedule" }],
    [{ text: "🌐  Прокси-подписка", callback_data: "proxy" }, { text: "🧪 Проверка прокси", callback_data: "px_home" }],
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

async function handleScheduleStep(cfg, chatId, text, state) {
  const value = String(text || "").trim();
  if (state.step === "schedule_date") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
    if (!match) {
      await sendMessage(cfg.telegramToken, chatId, "❌ Неверный формат. Отправь дату и время так: <code>2026-10-08 21:30</code>", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "schedule_cancel_flow" }]] });
      return;
    }
    await setState(cfg, chatId, { step: "schedule_uri", scheduleAction: state.scheduleAction, scheduleDate: match[1], scheduleTime: match[2] });
    await sendMessage(cfg.telegramToken, chatId,
      `${state.scheduleAction === "add" ? "➕" : "🗑"} <b>${state.scheduleAction === "add" ? "Добавление" : "Удаление"} сервера</b>\n\n⏰ <b>${escapeHtml(match[1])} ${escapeHtml(match[2])} МСК</b>\n\nТеперь отправь VLESS/VMess/Trojan/SS ссылку сервера.\n\n<i>Изменение будет применено к активной подписке.</i>`,
      { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "schedule_cancel_flow" }]] });
    return;
  }
  if (state.step === "schedule_uri") {
    if (!value || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      await sendMessage(cfg.telegramToken, chatId, "❌ Похоже, это не ссылка сервера. Отправь VLESS/VMess/Trojan/SS URI.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "schedule_cancel_flow" }]] });
      return;
    }
    try {
      const item = await addScheduledChange(cfg, chatId, { action: state.scheduleAction, date: state.scheduleDate, time: state.scheduleTime, uri: value });
      await clearState(cfg, chatId);
      await sendMessage(cfg.telegramToken, chatId, `✅ <b>Черновик создан</b>\n\n⏰ <b>${escapeHtml(state.scheduleDate)} ${escapeHtml(state.scheduleTime)} МСК</b>\n${state.scheduleAction === "add" ? "➕ Добавить" : "🗑 Удалить"} сервер\n📡 <code>${escapeHtml(value)}</code>\n📝 ID: <code>${escapeHtml(item.id)}</code>`, { inline_keyboard: [[{ text: "📝 Все черновики", callback_data: "schedule" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
    } catch (error) {
      await sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось создать черновик</b>\n\n<code>${escapeHtml(error.message || String(error))}</code>`, { inline_keyboard: [[{ text: "📝 Черновики", callback_data: "schedule" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
    }
  }
}

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
  let content = null;
  let storageAvailable = true;

  // /start must remain usable even when D1 is unavailable or over quota.
  // State cleanup and subscription status are best-effort only.
  try {
    await clearState(cfg, chatId);
  } catch (error) {
    storageAvailable = false;
    console.error("[Command] /start state cleanup skipped:", error);
  }

  if (storageAvailable) {
    try {
      content = await getFileContent(cfg, await getActiveFilename(cfg, chatId));
    } catch (error) {
      storageAvailable = false;
      console.error("[Command] /start subscription lookup skipped:", error);
    }
  }

  const links = content ? splitSubscriptionFile(content).links : [];
  const hasSubscription = Boolean(content);
  const status = !storageAvailable
    ? "🟡 БАЗА ВРЕМЕННО НЕДОСТУПНА"
    : hasSubscription
      ? "🟢 АКТИВНА"
      : "⚪ НЕ НАСТРОЕНА";
  const servers = hasSubscription ? links.length : 0;
  const admin = chatId === cfg.adminId;

  await sendMessage(
    cfg.telegramToken,
    chatId,
    `🌊 <b>OCEANIA VPN</b>\n<i>Control Center · быстрый доступ ко всему</i>\n\n` +
    `╭────────────────────╮\n` +
    `│ ${status}\n` +
    `│ 📡 Серверов: <b>${servers}</b>\n` +
    `│ 🔐 Профиль: <b>${storageAvailable ? (hasSubscription ? "готов" : "пуст") : "данные временно недоступны"}</b>\n` +
    `╰────────────────────╯\n\n` +
    `<b>Что делаем?</b>\n` +
    `Создаём профиль, проверяем серверы, декодируем подписки или открываем полезные функции.` +
    (storageAvailable ? "" : "\n\n⚠️ Команды, которым нужна база данных, заработают после снятия лимита D1."),
    mainMenu(admin)
  );
}
export async function cmdHelp(cfg, chatId) {
  await sendMessage(cfg.telegramToken, chatId,
    `ℹ️ <b>OCEANIA VPN · Справка</b>\n\n` +
    `<b>Основное</b>\n/start · главное меню\n/create · создать подписку\n/my · активная подписка\n/subs · все подписки и переключение\n/schedule · черновики: запланировать добавление/удаление сервера\n/list · серверы + проверка\n/add · добавить сервер/подписку\n/replace N · заменить сервер\n/delete N · удалить сервер\n/export · ссылки\n/decode · импортировать подписку\n/proxy · прокси-подписки\n\n` +
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

  if (!inputUrl) {
    await setState(cfg, chatId, { step: "decode_url" });
    return sendMessage(cfg.telegramToken, chatId,
      `🔗 <b>Ссылка подписки</b>\n\nОтправь HTTP(S)-ссылку или прямую ссылку <code>happ://crypt5/...</code> для декодирования.`,
      { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "decode_cancel" }]] });
  }

  if (/^happ:\/\/crypt5\//i.test(inputUrl)) {
    return runDecodeWithProfile(cfg, chatId, inputUrl);
  }
  let parsedUrl;
  try { parsedUrl = new URL(inputUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Нужна HTTP(S)-ссылка или happ://crypt5/</b>\n\nИспользуй <code>/decode https://example.com/sub</code>.`);
  }
  return runDecodeWithProfile(cfg, chatId, parsedUrl.toString());
}

async function handleDecodeFlowText(cfg, chatId, text, state) {
  const value = String(text || "").trim();
  const directCrypt5 = /^happ:\/\/crypt5\//i.test(value);
  let parsedUrl;
  try { parsedUrl = new URL(value); } catch { parsedUrl = null; }
  if (isTelegramProxyLink(value)) {
    await clearState(cfg, chatId);
    return addProxyLink(cfg, chatId, value);
  }
  if (!directCrypt5 && (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol))) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ Нужна HTTP(S)-ссылка или <code>happ://crypt5/...</code>. Отправь URL ещё раз или нажми «Отмена».`,
      { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "decode_cancel" }]] });
  }
  await clearState(cfg, chatId);
  return runDecodeWithProfile(cfg, chatId, directCrypt5 ? value : parsedUrl.toString());
}

async function runDecodeWithProfile(cfg, chatId, url) {
  const inputRawUrl = String(url || "").trim();
  const directCrypt5 = /^happ:\/\/crypt5\//i.test(inputRawUrl);
  let parsedUrl;
  try { parsedUrl = new URL(inputRawUrl); } catch { parsedUrl = null; }
  if (!directCrypt5 && (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol))) {
    return sendMessage(cfg.telegramToken, chatId, `❌ <b>Нужна HTTP(S)-ссылка или happ://crypt5/</b>`);
  }
  url = directCrypt5 ? inputRawUrl : parsedUrl.toString();
  let loadingMsgId = null;
  try {
    // Crypt5 hides the real subscription URL. Reveal it to the user, then
    // continue through the normal guarded HTTP(S) fetch path.
    if (directCrypt5) {
      const revealed = String(decryptCrypt5(inputRawUrl) || "").trim();
      let revealedUrl;
      try { revealedUrl = new URL(revealed); } catch { revealedUrl = null; }
      if (!revealedUrl || !["http:", "https:"].includes(revealedUrl.protocol)) {
        throw new Error("crypt5 расшифровался, но результат не является HTTP(S)-ссылкой");
      }
      url = revealedUrl.toString();
      parsedUrl = revealedUrl;
      await sendMessage(cfg.telegramToken, chatId,
        `🔓 <b>Crypt5-ссылка раскрыта</b>\n\n<code>${escapeHtml(url)}</code>\n\n⏭️ <b>Продолжаю по расшифрованной ссылке…</b>`);
    }
    const loadingMsg = await sendMessage(cfg.telegramToken, chatId, `⏳ <b>Декодирую подписку</b>\n\n🌐 Источник: <code>${escapeHtml(directCrypt5 ? "crypt5 → " + (parsedUrl?.hostname || "subscription") : parsedUrl.hostname)}</code>\n🌐 Прямой HTTP-запрос с авторизацией сервиса при необходимости\n🔍 Формат → извлечение → сохранение...`);
    if (loadingMsg?.result?.message_id) loadingMsgId = loadingMsg.result.message_id;
    const result = await decodeSubscription(url, false, false, {
      apiToken: cfg.subscriptionApiSecret || "",
      apiOrigin: cfg.workerOrigin || "",
      upstreamSecret: cfg.subscriptionUpstreamSecret || "",
      upstreamOrigin: cfg.subscriptionUpstreamOrigin || "",
    });
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
    const hostname = directCrypt5 ? "crypt5" : (parsedUrl.hostname || "subscription");
    const content = buildFile({ title: meta["profile-title"] || `Decoded • ${hostname}`, interval: meta["profile-update-interval"] || 4, webpage: meta["profile-web-page-url"] || url, announce: meta.announce || null }, uris);
    const res = await createOrUpdateFile(cfg, filename, content, `Decode from ${hostname}`);
    if (!(res.content || res.sha)) {
      const errorMsg = `❌ <b>Ошибка сохранения</b>\n\n${escapeHtml(res.message || "неизвестно")}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }
    const rawUrl = `${cfg.workerOrigin}/sub?f=${encodeURIComponent(filename)}`;
    await setLastDecodedProfile(cfg, chatId, filename).catch((error) => {
      console.warn("[Proxy] Could not store last decoded profile:", error?.message || error);
    });
    const androidProfileUrl = `${cfg.workerOrigin}/sub?u=${encodeURIComponent(chatId)}&f=${encodeURIComponent(filename)}&p=android`;
    const windowsProfileUrl = `${cfg.workerOrigin}/sub?u=${encodeURIComponent(chatId)}&f=${encodeURIComponent(filename)}&p=windows`;
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, hysteria: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++; else if (u.startsWith("vmess://")) stats.vmess++; else if (u.startsWith("trojan://")) stats.trojan++; else if (u.startsWith("ss://")) stats.ss++; else if (u.startsWith("hysteria")) stats.hysteria++; else stats.other++;
    }
    const kb = { inline_keyboard: [
      [{ text: "📋 Обычная подписка", url: rawUrl }],
      [{ text: "📱 Happ — Android", url: `happ://add/${encodeURIComponent(androidProfileUrl)}` }, { text: "🖥 Happ — Windows", url: `happ://add/${encodeURIComponent(windowsProfileUrl)}` }],
      [{ text: "🌐 Настроить прокси", callback_data: "px_home" }],
      [{ text: "📡 Серверы", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }],
    ] };
    const successMsg = `✅ <b>Подписка расшифрована</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 Серверов: <code>${uris.length}</code>\n🔌 VLESS <b>${stats.vless}</b> · VMess <b>${stats.vmess}</b>\n🔌 Trojan <b>${stats.trojan}</b> · SS <b>${stats.ss}</b>\n🔌 Hysteria <b>${stats.hysteria}</b> · Other <b>${stats.other}</b>\n━━━━━━━━━━━━━━━━━━━━\n🔗 <b>Обычная ссылка:</b> <code>${escapeHtml(rawUrl)}</code>\n📱 <b>Android-профиль:</b> <code>${escapeHtml(androidProfileUrl)}</code>\n🖥 <b>Windows-профиль:</b> <code>${escapeHtml(windowsProfileUrl)}</code>\n\nПрофили Android/Windows учитывают выбор прокси из меню. При включённом прокси поддерживаемые TCP-узлы будут оформлены как Happ JSON.`;
    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb); else await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
  } catch (err) {
    const errorMsg = `⚠️ <b>Ошибка декодирования</b>\n\n<code>${escapeHtml(err.message)}</code>`;
    if (loadingMsgId) { try { await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); } catch { await sendMessage(cfg.telegramToken, chatId, errorMsg); } } else await sendMessage(cfg.telegramToken, chatId, errorMsg);
  }
}

export async function cmdSchedule(cfg, chatId, args) {
  const action = String(args?.[0] || "").toLowerCase();
  if (!action || action === "list") return cmdScheduledList(cfg, chatId);

  if (action === "cancel" || action === "delete") {
    const id = String(args?.[1] || "");
    if (!id) return sendMessage(cfg.telegramToken, chatId, `🗑 <b>Удаление черновика</b>\\n\\nИспользуй: <code>/schedule cancel ID</code>`);
    const item = await cancelScheduledChange(cfg, chatId, id);
    return sendMessage(cfg.telegramToken, chatId,
      item
        ? `✅ Черновик <code>${escapeHtml(id)}</code> отменён.`
        : `❌ Черновик <code>${escapeHtml(id)}</code> не найден.`,
      { inline_keyboard: [[{ text: "📝 Черновики", callback_data: "schedule" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }

  if (action !== "add" && action !== "remove") {
    return sendMessage(cfg.telegramToken, chatId,
      `📝 <b>Черновики подписки</b>\\n\\n` +
      `Добавить сервер:\\n<code>/schedule add 2026-10-08 21:30 vless://...</code>\\n\\n` +
      `Удалить сервер:\\n<code>/schedule remove 2026-10-08 21:30 vless://...</code>\\n\\n` +
      `Время — московское (UTC+3).`);
  }

  const date = args?.[1];
  const time = args?.[2];
  const uri = args?.slice(3).join(" ").trim();
  if (!date || !time || !uri) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Формат: <code>/schedule ${action} YYYY-MM-DD HH:mm URI</code>`);
  }

  try {
    const item = await addScheduledChange(cfg, chatId, { action, date, time, uri });
    await sendMessage(cfg.telegramToken, chatId,
      `✅ <b>Изменение запланировано</b>\\n\\n` +
      `⏰ <b>${escapeHtml(date)} ${escapeHtml(time)} МСК</b>\\n` +
      `${action === "add" ? "➕ Добавить" : "🗑 Удалить"} сервер\\n` +
      `📡 <code>${escapeHtml(uri)}</code>\\n` +
      `📝 ID: <code>${escapeHtml(item.id)}</code>`,
      { inline_keyboard: [[{ text: "📝 Все черновики", callback_data: "schedule" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  } catch (error) {
    await sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось запланировать</b>\\n\\n<code>${escapeHtml(error.message || String(error))}</code>`);
  }
}

export async function cmdScheduledList(cfg, chatId) {
  const items = await listScheduledChanges(cfg, chatId);
  if (!items.length) {
    return sendMessage(cfg.telegramToken, chatId,
      `📝 <b>ЧЕРНОВИКИ</b>\\n\\nЗапланированных изменений нет.\\n\\nВыбери действие:`,
      { inline_keyboard: [
        [{ text: "➕ Запланировать добавление", callback_data: "schedule_add" }],
        [{ text: "🗑 Запланировать удаление", callback_data: "schedule_remove" }],
        [{ text: "🏠 Меню", callback_data: "menu" }]
      ] });
  }

  let text = `📝 <b>ЧЕРНОВИКИ ПОДПИСОК</b>\\n\\n`;
  const rows = [];
  for (const item of items.slice(0, 20)) {
    const when = new Date(item.executeAt).toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    });
    text += `<b>${escapeHtml(when)} МСК</b> · ${item.action === "add" ? "➕" : "🗑"} ${escapeHtml(item.subscriptionTitle || "Подписка")}\\n`;
    text += `<code>${escapeHtml(item.uri)}</code>\\nID: <code>${escapeHtml(item.id)}</code>\\n\\n`;
    rows.push([{ text: `❌ Отменить ${item.id}`, callback_data: `schedule_cancel_${item.id}` }]);
  }
  rows.push([{ text: "➕ Добавить сервер", callback_data: "schedule_add" }, { text: "🗑 Удалить сервер", callback_data: "schedule_remove" }]);
  rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  return sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: rows });
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
  const active = await getActiveSubscription(cfg, chatId);
  const content = active ? await getFileContent(cfg, active.filename) : null;
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписка ещё не создана</b>\n\nСоздай профиль или импортируй URL.`, { inline_keyboard: [[{ text: "🚀 Создать", callback_data: "create" }, { text: "🔍 Декодировать", callback_data: "decode" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  const { headers, links } = splitSubscriptionFile(content);
  const { pageUrl, subUrl } = await userUrls(cfg, chatId);
  const limit = Number.isInteger(active.deviceLimit) ? active.deviceLimit : 3;
  let registeredDevices = 0;
  try {
    if (cfg.db?.countSubscriptionDevices) registeredDevices = await cfg.db.countSubscriptionDevices(makeSubscriptionDeviceKey(chatId, active.id));
  } catch (error) {
    console.error("[Command] device count lookup failed:", error?.message || error);
  }
  const limitLabel = limit === 0 ? "без лимита" : `${registeredDevices}/${limit}`;
  const formatLabel = active.format === "json" ? "Happ JSON" : "VLESS/URI список";
  const msg = `📋 <b>МОЙ ПРОФИЛЬ</b>\n\n🟢 Статус: <b>АКТИВЕН</b>\n🏷 Подписка: <b>${escapeHtml(active.title || "Моя подписка")}</b>\n📡 Серверов: <code>${links.length}</code>\n🧾 Формат: <b>${formatLabel}</b>\n📱 Устройства: <code>${limitLabel}</code>\n\n<b>Параметры профиля</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>`;
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🧾 Формат подписки", callback_data: `sub_format_menu_${active.id}` }, { text: "📱 Устройства", callback_data: `dev_manage_${active.id}` }], [{ text: "🔗 Открыть подписку", url: subUrl }], [{ text: "🎨 Страница", url: pageUrl }, { text: "🖼 Тема", callback_data: "theme_pick" }], [{ text: "📡 Серверы", callback_data: "list" }, { text: "📤 Экспорт", callback_data: "export" }],
    [{ text: "🔀 Все подписки", callback_data: "subs" }], [{ text: "⚡ Проверка", callback_data: "check" }, { text: "📊 Аналитика", callback_data: "analytics" }], [{ text: "🗑 Удалить", callback_data: "delete" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
}

async function cmdSubscriptionFormatMenu(cfg, chatId, subscriptionId) {
  const item = (await listSubscriptions(cfg, chatId)).find((entry) => entry.id === subscriptionId);
  if (!item) return sendMessage(cfg.telegramToken, chatId, "❌ Подписка не найдена.", { inline_keyboard: [[{ text: "📋 Моя подписка", callback_data: "my" }]] });
  const isJson = item.format === "json";
  await sendMessage(cfg.telegramToken, chatId,
    `🧾 <b>ФОРМАТ ПОДПИСКИ</b>\n\nПодписка: <b>${escapeHtml(item.title || "Моя подписка")}</b>\nТекущий формат: <b>${isJson ? "Happ JSON" : "VLESS/URI список"}</b>\n\nВыбери один формат. Ответ никогда не будет содержать вперемешку JSON и ссылки.\n\n<i>В JSON-режиме преобразуются VLESS, VMess, Trojan и Shadowsocks. Протоколы, несовместимые с Xray JSON, не могут быть добавлены в этот формат.</i>`,
    { inline_keyboard: [[{ text: `${!isJson ? "✅ " : ""}VLESS / URI`, callback_data: `sub_fmt_${item.id}_links` }, { text: `${isJson ? "✅ " : ""}Happ JSON`, callback_data: `sub_fmt_${item.id}_json` }], [{ text: "↩️ Моя подписка", callback_data: "my" }]] });
}

async function cmdSetSubscriptionFormat(cfg, chatId, subscriptionId, format) {
  const item = await updateSubscriptionSettings(cfg, chatId, subscriptionId, { format });
  if (!item) return sendMessage(cfg.telegramToken, chatId, "❌ Подписка не найдена.");
  await sendMessage(cfg.telegramToken, chatId, `✅ Формат подписки изменён на <b>${format === "json" ? "Happ JSON" : "VLESS/URI список"}</b>.\nСсылка остаётся прежней; при следующем обновлении Happ получит выбранный формат.`, { inline_keyboard: [[{ text: "📋 Моя подписка", callback_data: "my" }, { text: "🧾 Формат", callback_data: `sub_format_menu_${item.id}` }]] });
}

async function cmdDeviceSettings(cfg, chatId, subscriptionId) {
  const item = (await listSubscriptions(cfg, chatId)).find((entry) => entry.id === subscriptionId);
  if (!item) return sendMessage(cfg.telegramToken, chatId, "❌ Подписка не найдена.", { inline_keyboard: [[{ text: "📋 Моя подписка", callback_data: "my" }]] });
  if (!cfg.db?.listSubscriptionDevices) return sendMessage(cfg.telegramToken, chatId, "⚠️ Учёт устройств недоступен: нужна D1 Database.");

  const deviceKey = makeSubscriptionDeviceKey(chatId, item.id);
  const devices = await cfg.db.listSubscriptionDevices(deviceKey);
  const limit = Number.isInteger(item.deviceLimit) ? item.deviceLimit : 3;
  let text = `📱 <b>УСТРОЙСТВА ПОДПИСКИ</b>\n\nПодписка: <b>${escapeHtml(item.title || "Моя подписка")}</b>\nЗарегистрировано: <code>${devices.length}</code>\nЛимит: <code>${limit === 0 ? "без лимита" : limit}</code>\n\n`;
  const rows = [];
  if (!devices.length) text += "Пока нет зарегистрированных устройств. Они появятся после первого запроса подписки из Happ или другого клиента с HWID.\n";
  devices.slice(0, 12).forEach((device, index) => {
    const label = [device.device_model, device.device_os].filter(Boolean).join(" · ") || `Устройство ${index + 1}`;
    const seen = device.last_seen ? new Date(device.last_seen).toLocaleString("ru-RU", { timeZone: "Europe/Belgrade", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "неизвестно";
    text += `\n<b>${index + 1}. ${escapeHtml(label)}</b>\nHWID: <code>…${escapeHtml(String(device.hwid || "").slice(-8))}</code>\nПоследний запрос: <code>${escapeHtml(seen)}</code>\n`;
    rows.push([{ text: `🗑 Удалить: ${label.slice(0, 22)}`, callback_data: `dev_rm_${item.id}_${device.device_ref}` }]);
  });
  rows.push([{ text: "Лимит: 1", callback_data: `dev_limit_${item.id}_1` }, { text: "2", callback_data: `dev_limit_${item.id}_2` }, { text: "3", callback_data: `dev_limit_${item.id}_3` }]);
  rows.push([{ text: "5", callback_data: `dev_limit_${item.id}_5` }, { text: "10", callback_data: `dev_limit_${item.id}_10` }, { text: "∞ Без лимита", callback_data: `dev_limit_${item.id}_0` }]);
  rows.push([{ text: "↻ Обновить", callback_data: `dev_manage_${item.id}` }, { text: "📋 Моя подписка", callback_data: "my" }]);
  await sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: rows });
}

async function cmdSetDeviceLimit(cfg, chatId, subscriptionId, limitValue) {
  const limit = Number.parseInt(limitValue, 10);
  if (![0, 1, 2, 3, 5, 10].includes(limit)) return;
  const item = await updateSubscriptionSettings(cfg, chatId, subscriptionId, { deviceLimit: limit });
  if (!item) return sendMessage(cfg.telegramToken, chatId, "❌ Подписка не найдена.");
  const count = cfg.db?.countSubscriptionDevices
    ? await cfg.db.countSubscriptionDevices(makeSubscriptionDeviceKey(chatId, item.id))
    : 0;
  if (limit > 0 && count > limit && cfg.db?.trimSubscriptionDevices) {
    await cfg.db.trimSubscriptionDevices(makeSubscriptionDeviceKey(chatId, item.id), limit);
  }
  await sendMessage(cfg.telegramToken, chatId, `✅ Лимит устройств: <b>${limit === 0 ? "без лимита" : limit}</b>.`, { inline_keyboard: [[{ text: "📱 Устройства", callback_data: `dev_manage_${item.id}` }, { text: "📋 Моя подписка", callback_data: "my" }]] });
  return cmdDeviceSettings(cfg, chatId, item.id);
}

async function cmdRemoveDevice(cfg, chatId, subscriptionId, deviceRef) {
  const item = (await listSubscriptions(cfg, chatId)).find((entry) => entry.id === subscriptionId);
  if (!item || !cfg.db?.removeSubscriptionDevice) return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось найти устройство или база недоступна.");
  const removed = await cfg.db.removeSubscriptionDevice(makeSubscriptionDeviceKey(chatId, item.id), deviceRef);
  await sendMessage(cfg.telegramToken, chatId, removed ? "✅ Устройство удалено. Один слот освобождён." : "⚠️ Устройство уже удалено или не найдено.");
  return cmdDeviceSettings(cfg, chatId, item.id);
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

function proxyPlatformKeyboard() {
  return { inline_keyboard: [
    [{ text: "📱 Android", callback_data: "px_platform_android" }, { text: "🖥 Windows", callback_data: "px_platform_windows" }],
    [{ text: "🏠 Главное меню", callback_data: "menu" }],
  ] };
}

function proxyModeKeyboard(platform) {
  return { inline_keyboard: [
    [{ text: "🚫 Без прокси", callback_data: `px_off_${platform}` }],
    [{ text: "🌐 С прокси", callback_data: `px_on_${platform}` }],
    [{ text: "⬅️ Назад", callback_data: "px_home" }],
  ] };
}

function proxyCountriesKeyboard(platform) {
  const rows = HTTP_PROXY_COUNTRIES.map((country, index) => [{
    text: `${country.flag} ${country.name} — ${country.servers.length} сервер${country.servers.length === 1 ? "" : country.servers.length < 5 ? "а" : "ов"}`,
    callback_data: `px_country_${platform}_${index}`,
  }]);
  rows.push([{ text: "⬅️ Назад", callback_data: `px_mode_${platform}` }]);
  return { inline_keyboard: rows };
}

async function proxySelectionMessage(cfg, chatId, platform, country, endpoint) {
  const subUrl = await platformSubscriptionUrl(cfg, chatId, platform);
  const hasProfileUrl = Boolean(subUrl);
  const humanPlatform = platform === "android" ? "Android" : "Windows";
  let text = `✅ <b>Прокси выбран и проверен</b>

` +
    `${country.flag} Страна: <b>${escapeHtml(country.name)}</b>
` +
    `📱 Платформа: <b>${humanPlatform}</b>
` +
    `🌐 Адрес: <code>${escapeHtml(endpoint)}</code>

` +
    `Для поддерживаемых узлов Happ JSON будет добавлена цепочка через этот HTTP-прокси. HTTP-прокси передаёт TCP; UDP-зависимые узлы могут не работать через такую цепочку.

`;
  if (hasProfileUrl) {
    text += `🔗 <b>Ссылка профиля для ${humanPlatform}:</b>
<code>${escapeHtml(subUrl)}</code>

Добавь эту ссылку в Happ как отдельную подписку. В обычной ссылке без параметра <code>p</code> выбранный прокси не применяется.`;
  } else {
    text += `Прокси сохранён, но активная подписка ещё не найдена. Сначала создай или декодируй подписку — после этого здесь появится ссылка профиля.`;
  }
  const rows = [];
  if (hasProfileUrl) rows.push([{ text: "🚀 Импортировать в Happ", url: `happ://add/${encodeURIComponent(subUrl)}` }]);
  rows.push([{ text: "🌍 Выбрать другую страну", callback_data: `px_on_${platform}` }]);
  rows.push([{ text: "🚫 Отключить прокси", callback_data: `px_off_${platform}` }]);
  rows.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
  return sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: rows });
}

async function showProxyCountry(cfg, chatId, platform, index) {
  const country = HTTP_PROXY_COUNTRIES[index];
  if (!country) return sendMessage(cfg.telegramToken, chatId, "❌ Страна не найдена.", proxyPlatformKeyboard());
  const current = await getProxyPreference(cfg, chatId, platform);
  const rows = [];
  country.servers.forEach((endpoint, i) => {
    const selected = current?.mode === "on" && current.endpoint === endpoint;
    rows.push([
      { text: `${selected ? "✅ " : "☑️ "}Выбрать ${i + 1}`, callback_data: `px_select_${platform}_${index}_${i}` },
      { text: `🧪 Проверить ${i + 1}`, callback_data: `px_check_one_${platform}_${index}_${i}` },
    ]);
  });
  rows.push([{ text: "🧪 Проверить все серверы", callback_data: `px_check_${platform}_${index}` }]);
  rows.push([{ text: "⬅️ К странам", callback_data: `px_on_${platform}` }]);
  await sendMessage(cfg.telegramToken, chatId,
    `${country.flag} <b>${escapeHtml(country.name)}</b>

` +
    `Серверов: <b>${country.servers.length}</b>
` +
    `${current?.mode === "on" && current.country === country.name ? `Сейчас выбран: <code>${escapeHtml(current.endpoint)}</code>

` : ""}` +
    `Сначала проверяй адрес, затем выбирай его. Выбранный адрес сохраняется для этой платформы.

` +
    `<i>Проверка измеряет время до HTTP CONNECT-ответа для example.com:443. Это не гарантирует доступ к каждому порту VPN-сервера.</i>`,
    { inline_keyboard: rows });
}

async function runProxyCountryCheck(cfg, chatId, platform, index, onlyServer = -1) {
  const country = HTTP_PROXY_COUNTRIES[index];
  if (!country) return sendMessage(cfg.telegramToken, chatId, "❌ Страна не найдена.", proxyPlatformKeyboard());
  const selected = onlyServer >= 0 ? country.servers[onlyServer] : null;
  if (onlyServer >= 0 && !selected) return sendMessage(cfg.telegramToken, chatId, "❌ Сервер не найден.", proxyCountriesKeyboard(platform));
  await sendMessage(cfg.telegramToken, chatId, `⏳ <b>Проверяю ${escapeHtml(country.name)}…</b>
Платформа: <b>${platform === "android" ? "Android" : "Windows"}</b>
Лимит ожидания: 2,5 секунды на сервер.`);
  const results = selected
    ? [{ endpoint: selected, ...(await checkProxyTcp(selected)) }]
    : await checkCountryProxies(country);
  const lines = results.map((item) => {
    const status = item.ok ? `🟢 HTTP CONNECT работает — <b>${item.ms} мс</b>` : `🔴 ${escapeHtml(item.reason)}${item.ms !== null ? ` — ${item.ms} мс` : ""}`;
    return `<code>${escapeHtml(item.endpoint)}</code>
${status}`;
  });
  const okCount = results.filter((item) => item.ok).length;
  const summary = [
    `📋 <b>Результат проверки: ${escapeHtml(country.name)}</b>`,
    `HTTP CONNECT подтверждён: <b>${okCount}/${results.length}</b>`,
    lines.join("\n\n"),
    `<i>Проверка идёт с Cloudflare Worker через CONNECT к example.com:443, не с телефона/ПК. Маршрут с устройства может отличаться; результат не гарантирует доступ к каждому VPN-узлу.</i>`,
  ].join("\n\n");
  const buttons = [];
  if (selected && results[0]?.ok) buttons.push([{ text: "✅ Использовать этот прокси", callback_data: `px_select_${platform}_${index}_${onlyServer}` }]);
  buttons.push([{ text: "🔄 Проверить снова", callback_data: onlyServer >= 0 ? `px_check_one_${platform}_${index}_${onlyServer}` : `px_check_${platform}_${index}` }]);
  buttons.push([{ text: "⬅️ К стране", callback_data: `px_country_${platform}_${index}` }]);
  await sendMessage(cfg.telegramToken, chatId, summary, { inline_keyboard: buttons });
}

async function selectProxyAfterCheck(cfg, chatId, platform, countryIndex, serverIndex) {
  const country = HTTP_PROXY_COUNTRIES[countryIndex];
  const endpoint = country?.servers?.[serverIndex];
  if (!country || !endpoint || !isKnownHttpProxyEndpoint(endpoint)) {
    return sendMessage(cfg.telegramToken, chatId, "❌ Сервер не найден в списке разрешённых прокси.", proxyPlatformKeyboard());
  }
  await sendMessage(cfg.telegramToken, chatId, `⏳ Проверяю <code>${escapeHtml(endpoint)}</code> перед сохранением…`);
  const result = await checkProxyTcp(endpoint);
  if (!result.ok) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Не сохраняю прокси: проверка не пройдена</b>

<code>${escapeHtml(endpoint)}</code>
${escapeHtml(result.reason)}

Проверь другой сервер из списка.`,
      { inline_keyboard: [[{ text: "🧪 Проверить другие", callback_data: `px_country_${platform}_${countryIndex}` }], [{ text: "⬅️ К странам", callback_data: `px_on_${platform}` }]] });
  }
  try {
    await setProxyPreference(cfg, chatId, platform, { mode: "on", endpoint, country: country.name });
  } catch (error) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось сохранить выбор: ${escapeHtml(error?.message || String(error))}`);
  }
  return proxySelectionMessage(cfg, chatId, platform, country, endpoint);
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
  if (data === "px_home") {
    const activeProxy = await getActiveProxyPreference(cfg, chatId);
    const pref = activeProxy.preference;
    const selectedText = pref?.mode === "on" && isKnownHttpProxyEndpoint(pref.endpoint)
      ? `\nТекущий выбор (${activeProxy.platform}): <code>${escapeHtml(pref.endpoint)}</code>`
      : `\nСейчас: <b>без прокси</b>`;
    return sendMessage(cfg.telegramToken, chatId,
      `🌐 <b>Прокси для профиля</b>\n\nВыбери платформу и режим.${selectedText}\n\n` +
      `При выборе прокси отдельная Happ JSON-подписка направит TCP-соединение VPN-клиента к VPN-узлу через выбранный HTTP-прокси. Сам запрос, которым Happ загружает подписку с Worker, остаётся обычным HTTPS-запросом.`,
      proxyPlatformKeyboard());
  }
  if (data === "px_platform_android" || data === "px_platform_windows") {
    const platform = data.endsWith("android") ? "android" : "windows";
    const pref = await getProxyPreference(cfg, chatId, platform);
    const currentText = pref?.mode === "on" && isKnownHttpProxyEndpoint(pref.endpoint)
      ? `\n\nСейчас выбран: <code>${escapeHtml(pref.country || "")}</code> · <code>${escapeHtml(pref.endpoint)}</code>`
      : pref?.mode === "off" ? `\n\nСейчас: без прокси` : "";
    await setProxyPreference(cfg, chatId, platform, pref?.mode === "on" && isKnownHttpProxyEndpoint(pref.endpoint)
      ? pref
      : { mode: "off" });
    return sendMessage(cfg.telegramToken, chatId,
      `🌐 <b>Прокси — ${platform === "android" ? "Android" : "Windows"}</b>${currentText}\n\nИспользовать HTTP-прокси или оставить прямое подключение?`,
      proxyModeKeyboard(platform));
  }
  if (data.startsWith("px_mode_")) {
    const platform = data.endsWith("android") ? "android" : "windows";
    return sendMessage(cfg.telegramToken, chatId, `🌐 <b>Прокси — ${platform === "android" ? "Android" : "Windows"}</b>\n\nВыбери режим.`, proxyModeKeyboard(platform));
  }
  if (data.startsWith("px_off_")) {
    const platform = data.endsWith("android") ? "android" : "windows";
    try { await setProxyPreference(cfg, chatId, platform, { mode: "off" }); }
    catch (error) { return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось сохранить режим: ${escapeHtml(error?.message || String(error))}`); }
    const subUrl = await platformSubscriptionUrl(cfg, chatId, platform);
    const humanPlatform = platform === "android" ? "Android" : "Windows";
    const text = `🚫 <b>Прокси отключён для ${humanPlatform}.</b>\n\n` +
      `В профиле <code>p=${platform}</code> цепочка через выбранный прокси не используется. Если профиль уже импортирован в Happ, обнови его.` +
      (subUrl ? `\n\n🔗 <b>Ссылка профиля без прокси:</b>\n<code>${escapeHtml(subUrl)}</code>` : "\n\nСначала создай или декодируй подписку, чтобы получить ссылку профиля.");
    const rows = [];
    if (subUrl) rows.push([{ text: "🚀 Открыть профиль в Happ", url: `happ://add/${encodeURIComponent(subUrl)}` }]);
    rows.push([{ text: "🌐 Выбрать прокси", callback_data: `px_on_${platform}` }]);
    rows.push([{ text: "⬅️ К выбору платформы", callback_data: "px_home" }]);
    rows.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
    return sendMessage(cfg.telegramToken, chatId, text, { inline_keyboard: rows });
  }
  if (data.startsWith("px_on_")) {
    const platform = data.endsWith("android") ? "android" : "windows";
    // Keep the currently selected working proxy until the new candidate passes its test.
    return sendMessage(cfg.telegramToken, chatId, `🌐 <b>Выбор страны прокси — ${platform === "android" ? "Android" : "Windows"}</b>\n\nВыбери страну, затем сначала проверь адрес и нажми «Выбрать».`, proxyCountriesKeyboard(platform));
  }
  {
    const match = data.match(/^px_country_(android|windows)_(\d+)$/);
    if (match) return showProxyCountry(cfg, chatId, match[1], Number(match[2]));
  }
  {
    const match = data.match(/^px_check_(android|windows)_(\d+)$/);
    if (match) return runProxyCountryCheck(cfg, chatId, match[1], Number(match[2]));
  }
  {
    const match = data.match(/^px_check_one_(android|windows)_(\d+)_(\d+)$/);
    if (match) return runProxyCountryCheck(cfg, chatId, match[1], Number(match[2]), Number(match[3]));
  }
  {
    const match = data.match(/^px_select_(android|windows)_(\d+)_(\d+)$/);
    if (match) return selectProxyAfterCheck(cfg, chatId, match[1], Number(match[2]), Number(match[3]));
  }
  if (data === "menu") await cmdStart(cfg, chatId);
  else if (data === "features") await sendMessage(cfg.telegramToken, chatId, `⚡ <b>ПОЛЕЗНЫЕ ФУНКЦИИ</b>\n\nПять быстрых инструментов для любого пользователя:`, { inline_keyboard: [[{ text: "⚡ Проверить серверы", callback_data: "check" }], [{ text: "🏆 Найти лучший", callback_data: "best" }], [{ text: "🧹 Убрать дубли", callback_data: "clean" }], [{ text: "📊 Аналитика", callback_data: "analytics" }], [{ text: "📤 Поделиться", callback_data: "share" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  else if (data === "check") await cmdCheck(cfg, chatId);
  else if (data === "best") await cmdBest(cfg, chatId);
  else if (data === "clean") await cmdClean(cfg, chatId);
  else if (data === "analytics") await cmdAnalytics(cfg, chatId);
  else if (data === "share") await cmdShare(cfg, chatId);
  else if (data === "tools") await sendMessage(cfg.telegramToken, chatId, `🧰 <b>Инструменты</b>\n\n📡 Серверы — ping и latency\n🔍 Декодер — импорт подписки\n📤 Экспорт — ссылки\n🌐 Прокси-подписка — общий каталог\n🎨 Оформление — темы\n⚡ Полезные функции — проверка, лучший сервер, очистка, аналитика, шаринг`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }, { text: "🔍 Декодер", callback_data: "decode" }], [{ text: "🌐 Прокси", callback_data: "proxy" }, { text: "🧪 Проверка", callback_data: "px_home" }], [{ text: "📤 Экспорт", callback_data: "export" }], [{ text: "⚡ Функции", callback_data: "features" }], [{ text: "🎨 Темы", callback_data: "theme_pick" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  else if (data === "proxy") await cmdProxy(cfg, chatId);
  else if (data === "dev") await cmdDev(cfg, chatId, userId);
  else if (data === "dev_ping") await cmdDevPing(cfg, chatId, userId);
  else if (data === "dev_diag") await cmdDevDiag(cfg, chatId, userId);
  else if (data === "dev_metrics") await cmdDevMetrics(cfg, chatId, userId);
  else if (data === "create") { await setState(cfg, chatId, { step: "title" }); await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); }
  else if (data === "decode") await cmdDecode(cfg, chatId, "");
  else if (data === "decode_platform_android" || data === "decode_platform_windows" || data === "decode_version_default") {
    await clearState(cfg, chatId);
    await sendMessage(cfg.telegramToken, chatId,
      `Выбор профиля отключён: декодер не выдаёт себя за клиент. Отправь ссылку через /decode.`,
      { inline_keyboard: [[{ text: "🔍 Декодировать", callback_data: "decode" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }
  else if (data === "decode_cancel") {
    await clearState(cfg, chatId);
    await sendMessage(cfg.telegramToken, chatId, `❌ Настройка декодера отменена.`, { inline_keyboard: [[{ text: "🔍 Декодировать", callback_data: "decode" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }
  else if (data === "my") await cmdMy(cfg, chatId);
  else if (data === "subs") await cmdSubscriptions(cfg, chatId);
  else if (data === "schedule") await cmdScheduledList(cfg, chatId);
  else if (data === "schedule_add" || data === "schedule_remove") {
    const scheduleAction = data === "schedule_add" ? "add" : "remove";
    await setState(cfg, chatId, { step: "schedule_date", scheduleAction });
    await sendMessage(cfg.telegramToken, chatId,
      `${scheduleAction === "add" ? "➕" : "🗑"} <b>${scheduleAction === "add" ? "Запланировать добавление" : "Запланировать удаление"}</b>\n\nОтправь дату и время в формате <code>YYYY-MM-DD HH:mm</code>.\nНапример: <code>2026-10-08 21:30</code> (МСК).\n\n<i>Изменение будет применено к активной подписке.</i>`,
      { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "schedule_cancel_flow" }]] });
  }
  else if (data === "schedule_cancel_flow") {
    await clearState(cfg, chatId);
    await cmdScheduledList(cfg, chatId);
  }
  else if (data.startsWith("schedule_cancel_")) {
    const id = data.substring("schedule_cancel_".length);
    const item = await cancelScheduledChange(cfg, chatId, id);
    await sendMessage(cfg.telegramToken, chatId, item ? `✅ Черновик <code>${escapeHtml(id)}</code> отменён.` : `❌ Черновик не найден.`, { inline_keyboard: [[{ text: "📝 Черновики", callback_data: "schedule" }], [{ text: "🏠 Меню", callback_data: "menu" }]] });
  }
  else if (data.startsWith("sub_format_menu_")) await cmdSubscriptionFormatMenu(cfg, chatId, data.substring("sub_format_menu_".length));
  else if (data.startsWith("sub_fmt_") && /_json$/.test(data)) {
    const id = data.slice("sub_fmt_".length, -"_json".length);
    await cmdSetSubscriptionFormat(cfg, chatId, id, "json");
  }
  else if (data.startsWith("sub_fmt_") && /_links$/.test(data)) {
    const id = data.slice("sub_fmt_".length, -"_links".length);
    await cmdSetSubscriptionFormat(cfg, chatId, id, "links");
  }
  else if (data.startsWith("dev_manage_")) await cmdDeviceSettings(cfg, chatId, data.substring("dev_manage_".length));
  else if (data.startsWith("dev_limit_")) {
    const match = data.match(/^dev_limit_(.+)_(0|1|2|3|5|10)$/);
    if (match) await cmdSetDeviceLimit(cfg, chatId, match[1], match[2]);
  }
  else if (data.startsWith("dev_rm_")) {
    const match = data.match(/^dev_rm_(.+)_([a-f0-9]{8,16})$/i);
    if (match) await cmdRemoveDevice(cfg, chatId, match[1], match[2]);
  }
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
  else if (data === "save_alive") { const cached = await cfg.store.get(`pingcache_${chatId}`, "json"); if (!cached || !cached.uris?.length) await sendMessage(cfg.telegramToken, chatId, `⌛ <b>Кэш устарел</b>\n\nЗапусти /decode заново.`); else { const userFile = await getActiveFilename(cfg, chatId); const content = buildFile({ title: cached.title, interval: 4 }, cached.uris); const res = await createOrUpdateFile(cfg, userFile, content, `Save ${cached.uris.length} alive servers`); if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `✅ <b>Подписка сохранена</b>\n\n🟢 Серверов: <code>${cached.uris.length}</code>`, { inline_keyboard: [[{ text: "📡 Серверы", callback_data: "list" }], [{ text: "🏠 Меню", callback_data: "menu" }]] }); else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`); } }
  else if (data === "help") await cmdHelp(cfg, chatId);
  else {
    console.warn("[Callback] Unknown callback_data:", data);
    await sendMessage(cfg.telegramToken, chatId, `⚠️ <b>Кнопка устарела.</b>\\n\\nОткрой меню заново.`, { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  }
}

export async function handleMessage(cfg, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const trimmed = text.trim();

  if (msg.document) {
    return sendMessage(
      cfg.telegramToken,
      chatId,
      `⛔️ <b>Для прокси теперь отправляется именно ссылка Telegram-прокси.</b>\n\nОткрой раздел «🌐 Прокси-подписка» и просто пришли ссылку.`
    );
  }

  // Route slash commands BEFORE touching D1 state. This is critical when D1
  // is over quota: /start, /help and other non-storage commands must still work.
  if (trimmed.startsWith("/")) {
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].split("@")[0].toLowerCase();
    const userId = msg.from?.id || chatId;

    if (cmd === "/start") return cmdStart(cfg, chatId);
    if (cmd === "/help") return cmdHelp(cfg, chatId);
    if (cmd === "/create") return cmdCreate(cfg, chatId);
    if (cmd === "/decode") return cmdDecode(cfg, chatId, parts.slice(1).join(" "));
    if (cmd === "/my") return cmdMy(cfg, chatId);
    if (cmd === "/subs") return cmdSubscriptions(cfg, chatId);
    if (cmd === "/schedule") return cmdSchedule(cfg, chatId, parts.slice(1));
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
    if (cmd === "/delete") {
      if (parts.length > 1) return cmdDeleteServer(cfg, chatId, parts[1]);
      return cmdDelete(cfg, chatId);
    }
    if (cmd === "/cancel") return cmdCancel(cfg, chatId);
    if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
    if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
    if (cmd === "/dev") return cmdDev(cfg, chatId, userId);

    return;
  }

  if (!trimmed) return;

  // A URL sent during the decoder wizard is the answer to its current step;
  // otherwise, a bare URL starts the normal decoder setup flow.
  if (/^https?:\/\//i.test(trimmed)) {
    let pendingState = null;
    try { pendingState = await getState(cfg, chatId); } catch {}
    if (pendingState?.step && String(pendingState.step).startsWith("decode_")) {
      return handleDecodeFlowText(cfg, chatId, trimmed, pendingState);
    }
    return cmdDecode(cfg, chatId, trimmed);
  }

  if (isTelegramProxyLink(trimmed)) {
    try {
      return await addProxyLink(cfg, chatId, trimmed);
    } catch (error) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        `❌ <b>База данных сейчас недоступна.</b>\n\nЭта функция требует сохранения данных.\n<code>${escapeHtml(error.message || String(error))}</code>`
      );
    }
  }

  // Non-command conversation steps may need D1 state. Only these flows should
  // be blocked when the database is over quota.
  let state;
  try {
    state = await getState(cfg, chatId);
  } catch (error) {
    console.error("[Command] D1 state unavailable:", error);
    return sendMessage(
      cfg.telegramToken,
      chatId,
      "⚠️ <b>База данных временно недоступна.</b>\n\nКоманды без базы продолжают работать. Эта операция требует чтения/записи данных."
    );
  }

  if (state?.step === "schedule_date" || state?.step === "schedule_uri") {
    return handleScheduleStep(cfg, chatId, trimmed, state);
  }

  if (state?.step && String(state.step).startsWith("decode_")) {
    return handleDecodeFlowText(cfg, chatId, trimmed, state);
  }

  if (state?.step) {
    return handleStepAnswer(cfg, chatId, trimmed, state);
  }
}
