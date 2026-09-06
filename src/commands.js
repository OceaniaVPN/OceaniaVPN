import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription, checkServersAlive } from "./decoder.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";
import { COUNTRIES, matchesCountryKey, detectCountryFromText } from "./contries.js";

// ═══════ ВСПОМОГАТЕЛЬНОЕ: разбор файла подписки на заголовки/серверы ═══════

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

function userUrls(cfg, chatId) {
  return {
    subUrl: `${cfg.workerOrigin}/sub?u=${chatId}`,
    pageUrl: `${cfg.workerOrigin}/page?u=${chatId}`,
  };
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🚀  Создать подписку", callback_data: "create" }],
      [
        { text: "📋  Моя подписка", callback_data: "my" },
        { text: "📡  Серверы", callback_data: "list" },
      ],
      [
        { text: "🔍  Декодер", callback_data: "decode" },
        { text: "📤  Экспорт", callback_data: "export" },
      ],
      [{ text: "ℹ️  Помощь", callback_data: "help" }],
    ],
  };
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
    const kb = {
      inline_keyboard: [
        [{ text: "📋 Моя подписка", callback_data: "my" }],
        [{ text: "🎨 Страница подписки", url: pageUrl }, { text: "🖼 Сменить тему", callback_data: "theme_pick" }],
        [{ text: "📡 Список серверов", callback_data: "list" }],
        [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }],
        [{ text: "🗑 Удалить подписку", callback_data: "delete" }],
      ]
    };
    await sendMessage(
      cfg.telegramToken, chatId,
      `✅ <b>Подписка создана!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов:</b> <code>${uris.length}</code>\n🔗 <b>Ссылка подписки:</b>\n<code>${subUrl}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 <b>Импортируй в:</b>\n• v2rayNG → Подписка → +\n• Hiddify → Добавить профиль\n• Shadowrocket → + → Тип: Subscribe`,
      kb
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
  }
}

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  const links = content ? splitSubscriptionFile(content).links : [];
  const hasSubscription = Boolean(content);
  const status = hasSubscription ? "🟢 Активна" : "⚪ Не настроена";
  const servers = hasSubscription ? `<code>${links.length}</code>` : "—";
  await sendMessage(cfg.telegramToken, chatId,
    `🌊 <b>OceaniaVPN</b>\n<i>Private VPN • Control Center</i>\n\n━━━━━━━━━━━━━━━━━━━━\n<b>Ваша подписка</b>\n\n${status}     ·     📡 ${servers} серверов\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Быстрые действия</b>\nСоздайте подписку, управляйте серверами\nили импортируйте готовую конфигурацию.\n\n<i>Без лишних экранов. Всё важное — здесь.</i>`,
    mainMenu());
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(cfg.telegramToken, chatId,
    `ℹ️ <b>Помощь OceaniaVPN</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n\n<b>📋 Основные команды</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n/start — главное меню\n/create — создать подписку\n/decode &lt;url&gt; — расшифровать\n/my — показать мою подписку\n/list — список серверов с названиями стран\n/replace N &lt;ссылка&gt; — заменить сервер №N\n/export — получить raw ссылку\n/add &lt;url&gt; — добавить сервер\n/delete N — удалить сервер №N\n/delete — удалить всю подписку\n/cancel — отменить создание\n\n━━━━━━━━━━━━━━━━━━━━━━━\n<b>🔍 Форматы декодера</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n✅ <b>YAML</b> — Clash / Mihomo / Metacubex\n✅ <b>JSON</b> — Xray / Sing-box / Hiddify / V2RayTun\n✅ <b>Base64</b> — стандартные v2ray подписки\n✅ <b>Plain text</b> — список vless://vmess://...\n✅ <b>Happ redirect</b> — HTML страницы с кнопкой\n⚠️ <b>crypt5/crypt4</b> — нужно открыть в Happ и экспортировать\n\n━━━━━━━━━━━━━━━━━━━━━━━\n<b>📱 Поддерживаемые протоколы</b>\n━━━━━━━━━━━━━━━━━━━━━━━\n• VLESS (xtls-vision, reality)\n• VMess\n• Trojan\n• Shadowsocks\n• Hysteria / Hysteria2\n• Tuic\n• WireGuard`, backToMenuKeyboard());
}

export async function cmdCreate(cfg, chatId) {
  await setState(cfg, chatId, { step: "title" });
  await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
}

export async function cmdCancel(cfg, chatId) {
  const state = await getState(cfg, chatId);
  if (state) {
    await clearState(cfg, chatId);
    await sendMessage(cfg.telegramToken, chatId, `❌ <b>Создание отменено.</b>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `ℹ️ Нет активного процесса.`);
  }
}

export async function cmdDecode(cfg, chatId, url) {
  const inputUrl = String(url || "").trim();
  let parsedUrl;
  try { parsedUrl = new URL(inputUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Нужна корректная HTTP(S)-ссылка</b>\n\n<code>/decode https://example.com/sub</code>\n\nИли просто отправь URL отдельным сообщением.`);
  }
  url = parsedUrl.toString();
  let loadingMsgId = null;

  try {
    const loadingMsg = await sendMessage(
      cfg.telegramToken, chatId,
      `⏳ <b>Декодирую подписку</b>\n\n🌐 <b>Источник:</b> <code>${escapeHtml(parsedUrl.hostname)}</code>\n🥷 <b>Режим:</b> Happ-compatible\n🔍 Проверяю формат и извлекаю конфигурации...`
    );

    if (loadingMsg?.result?.message_id) loadingMsgId = loadingMsg.result.message_id;

    // Не запускаем TCP-проверку прямо внутри декодера: /decode должен сначала быстро
    // разобрать и сохранить конфигурации. Проверка серверов остаётся отдельной функцией /list.
    const result = await decodeSubscription(url, false, false);

    if (!result.ok) {
      const errorMsg = `❌ <b>Не удалось расшифровать</b>\n\n${result.error}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg);
      else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }

    if (loadingMsgId) {
      await editMessage(cfg.telegramToken, chatId, loadingMsgId,
        `⏳ <b>Конфигурации найдены</b>\n\n📡 Серверов: <code>${(result.uris || []).length}</code>\n💾 Сохраняю результат...`);
    }

    const uris = result.uris || [];
    const timestamp = Date.now().toString(36);
    const filename = `decoded_${chatId}_${timestamp}.txt`;
    const meta = result.metadata || {};
    let hostname = parsedUrl.hostname || "subscription";

    const content = buildFile(
      {
        title: meta["profile-title"] || `Decoded • ${hostname}`,
        interval: meta["profile-update-interval"] || 4,
        webpage: meta["profile-web-page-url"] || url,
        announce: meta.announce || null,
      },
      uris
    );

    const res = await createOrUpdateFile(cfg, filename, content, `Decode from ${hostname}`);
    if (!(res.content || res.sha)) {
      const errorMsg = `❌ <b>Ошибка сохранения</b>\n\n${res.message || "неизвестно"}`;
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg);
      else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }

    const rawUrl = `${cfg.workerOrigin}/sub?f=${encodeURIComponent(filename)}`;
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, hysteria: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++;
      else if (u.startsWith("vmess://")) stats.vmess++;
      else if (u.startsWith("trojan://")) stats.trojan++;
      else if (u.startsWith("ss://")) stats.ss++;
      else if (u.startsWith("hysteria")) stats.hysteria++;
      else stats.other++;
    }

    const aliveFlags = result.aliveFlags || [];
    const aliveCount = result.aliveCount ?? aliveFlags.filter(Boolean).length;
    const deadCount = result.deadCount ?? (aliveFlags.length - aliveCount);
    const aliveUris = uris.filter((_, i) => aliveFlags[i]);
    const kb = { inline_keyboard: [[{ text: "📋 Открыть подписку", url: rawUrl }]] };

    if (aliveFlags.length > 0 && deadCount > 0 && aliveCount > 0) {
      await cfg.kv.put(`pingcache_${chatId}`, JSON.stringify({ uris: aliveUris, title: meta["profile-title"] || `Decoded • ${hostname}` }), { expirationTtl: 600 });
      kb.inline_keyboard.push([{ text: `✅ Сохранить только рабочие (${aliveCount})`, callback_data: "save_alive" }]);
    }

    kb.inline_keyboard.push([{ text: "📡 Список серверов", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]);
    const pingLine = aliveFlags.length > 0
      ? `\n🟢 <b>Рабочих:</b> <code>${aliveCount}</code> · 🔴 <b>Не отвечают:</b> <code>${deadCount}</code>\n`
      : "";

    const successMsg = `✅ <b>Успешно расшифровано!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов найдено:</b> <code>${uris.length}</code>${pingLine}\n<b>Протоколы:</b>\n` +
      `${stats.vless ? `• VLESS: <b>${stats.vless}</b>\n` : ""}` +
      `${stats.vmess ? `• VMess: <b>${stats.vmess}</b>\n` : ""}` +
      `${stats.trojan ? `• Trojan: <b>${stats.trojan}</b>\n` : ""}` +
      `${stats.ss ? `• Shadowsocks: <b>${stats.ss}</b>\n` : ""}` +
      `${stats.hysteria ? `• Hysteria: <b>${stats.hysteria}</b>\n` : ""}` +
      `${stats.other ? `• Другое: <b>${stats.other}</b>\n` : ""}` +
      `\n🔗 <b>Raw ссылка:</b>\n<code>${rawUrl}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 Вставь в v2rayNG / Hiddify / Shadowrocket`;

    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb);
    else await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
  } catch (err) {
    const errorMsg = `⚠️ <b>Ошибка декодирования</b>\n\n<code>${escapeHtml(err.message)}</code>\n\nПопробуй ещё раз.`;
    if (loadingMsgId) {
      try { await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); }
      catch { await sendMessage(cfg.telegramToken, chatId, errorMsg); }
    } else {
      await sendMessage(cfg.telegramToken, chatId, errorMsg);
    }
  }
}

export async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId,
      `📭 <b>Подписка ещё не создана</b>\n\nСоздай новую подписку или импортируй готовую ссылку.`,
      { inline_keyboard: [
        [{ text: "🚀 Создать подписку", callback_data: "create" }],
        [{ text: "🔍 Импортировать URL", callback_data: "decode" }],
        [{ text: "🏠 Главное меню", callback_data: "menu" }],
      ] });
  }

  const { headers, links } = splitSubscriptionFile(content);
  const msg = `📋 <b>Моя подписка</b>\n<i>Ваш VPN-профиль</i>\n\n━━━━━━━━━━━━━━━━━━━━\n🟢 <b>Статус</b>\nАктивна\n\n📡 <b>Серверов</b>\n<code>${links.length}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n<b>⚙️ Параметры профиля</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>`;
  const { subUrl: mySubUrl, pageUrl: myPageUrl } = userUrls(cfg, chatId);
  await sendMessage(cfg.telegramToken, chatId, msg, { inline_keyboard: [[{ text: "🎨 Страница подписки", url: myPageUrl }, { text: "🖼 Сменить тему", callback_data: "theme_pick" }], [{ text: "📡 Список серверов", callback_data: "list" }], [{ text: "📤 Экспорт", callback_data: "export" }], [{ text: "🗑 Удалить подписку", callback_data: "delete" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
}

export async function cmdList(cfg, chatId, page = 0) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Подписка ещё не создана</b>\n\nСоздай новую подписку или импортируй готовую ссылку.`, { inline_keyboard: [[{ text: "🚀 Создать подписку", callback_data: "create" }], [{ text: "🔍 Импортировать URL", callback_data: "decode" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  const { links } = splitSubscriptionFile(content);
  if (links.length === 0) return sendMessage(cfg.telegramToken, chatId, `📭 <b>Серверов пока нет</b>\n\nДобавь VLESS/VMess/Trojan или импортируй готовую подписку.`, { inline_keyboard: [[{ text: "➕ Добавить сервер", callback_data: "add_prompt" }], [{ text: "🔍 Импортировать подписку", callback_data: "decode" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  const PER_PAGE = 20;
  const totalPages = Math.max(1, Math.ceil(links.length / PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PER_PAGE;
  const pageLinks = links.slice(start, start + PER_PAGE);
  const aliveFlags = await checkServersAlive(pageLinks, { concurrency: 8, timeoutMs: 2000 });
  let msg = `📡 <b>Серверы</b>\n<i>Проверка доступности в реальном времени</i>\n\n<b>${safePage * PER_PAGE + 1}–${Math.min(start + pageLinks.length, links.length)}</b> из <b>${links.length}</b>  ·  страница ${safePage + 1}/${totalPages}\n\n`;
  pageLinks.forEach((uri, i) => { const num = start + i + 1; const country = detectCountry(uri); const label = country ? `${country.flag} ${country.name}` : "🌍 Неизвестно"; const status = aliveFlags[i] ? "🟢" : "🔴"; msg += `<b>${num}.</b> ${status} ${label} <i>(${protocolOf(uri)})</i>\n`; });
  msg += `\n💡 <code>/delete N</code> — удалить сервер\n💡 <code>/replace N ссылка</code> — заменить сервер`;
  const navRow = [];
  if (safePage > 0) navRow.push({ text: "⬅️ Назад", callback_data: `list_page_${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: "Далее ➡️", callback_data: `list_page_${safePage + 1}` });
  const kb = { inline_keyboard: [] };
  if (navRow.length) kb.inline_keyboard.push(navRow);
  kb.inline_keyboard.push([{ text: "🗑 Как удалить", callback_data: "delsrv_prompt" }, { text: "🔁 Как заменить", callback_data: "replacesrv_prompt" }]);
  kb.inline_keyboard.push([{ text: "➕ Добавить сервер", callback_data: "add_prompt" }]);
  kb.inline_keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create или /decode`);
  const { subUrl: expSubUrl, pageUrl: expPageUrl } = userUrls(cfg, chatId);
  const kb = { inline_keyboard: [[{ text: "🔗 Ссылка подписки", url: expSubUrl }], [{ text: "🎨 Страница подписки", url: expPageUrl }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] };
  await sendMessage(cfg.telegramToken, chatId, `📤 <b>Экспорт</b>\n<i>Одна ссылка — все ваши серверы</i>\n\n━━━━━━━━━━━━━━━━━━━━\n🔗 <b>Ссылка подписки</b>\n<code>${expSubUrl}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Поддерживаемые клиенты</b>\n• v2rayNG\n• Hiddify\n• Shadowrocket\n• Clash Meta\n\n<i>Нажмите кнопку ниже, чтобы открыть нужный вариант.</i>`, kb);
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) return sendMessage(cfg.telegramToken, chatId, `❌ <b>Используй:</b>\n<code>/add vless://...</code>`);
  const userFile = `user_${chatId}.txt`;
  const existing = await getFileContent(cfg, userFile);
  if (!existing) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create`);
  const { headers, links } = splitSubscriptionFile(existing);
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) { const result = await decodeSubscription(url); if (result.ok && result.uris?.length > 0) toAdd = result.uris; else return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось декодировать: ${result.error}`); }
  else if (!url.includes("://")) return sendMessage(cfg.telegramToken, chatId, `❌ Не похоже на VPN ссылку.`);
  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, `Add ${toAdd.length} nodes`);
  if (res.content || res.sha) {
    const aliveFlags = await checkServersAlive(toAdd, { concurrency: 8, timeoutMs: 2000 });
    const aliveCount = aliveFlags.filter(Boolean).length;
    const deadCount = aliveFlags.length - aliveCount;
    const pingLine = toAdd.length > 1 ? `\n🟢 Рабочих: <code>${aliveCount}</code> · 🔴 Не отвечают: <code>${deadCount}</code>` : `\n${aliveFlags[0] ? "🟢 Сервер отвечает" : "🔴 Сервер не отвечает (добавлен, но может не работать)"}`;
    await sendMessage(cfg.telegramToken, chatId, `✅ <b>Сервер добавлен</b>\n\n📡 Добавлено: <code>${toAdd.length}</code>\n📊 Всего серверов: <code>${links.length}</code>${pingLine}`, { inline_keyboard: [[{ text: "📡 Открыть серверы", callback_data: "list" }], [{ text: "➕ Добавить ещё", callback_data: "add_prompt" }, { text: "📋 Моя подписка", callback_data: "my" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
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
  if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Сервер №${n} удалён</b>\n\n${escapeHtml(removed.slice(0, 120))}`, { inline_keyboard: [[{ text: "📡 Открыть список", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
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
  if (res.content || res.sha) await sendMessage(cfg.telegramToken, chatId, `🔁 <b>Сервер №${n} заменён</b>\n\nТеперь в подписке <code>${links.length}</code> серверов.`, { inline_keyboard: [[{ text: "📡 Проверить серверы", callback_data: "list" }, { text: "🏠 Меню", callback_data: "menu" }]] });
  else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
}

export async function cmdDelete(cfg, chatId) {
  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет`);
  const res = await deleteFile(cfg, userFile, `Delete subscription for user ${chatId}`);
  if (res) await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Подписка удалена</b>\n\nМожно создать новую в любой момент.`, { inline_keyboard: [[{ text: "🚀 Создать подписку", callback_data: "create" }, { text: "🏠 Меню", callback_data: "menu" }]] });
  else await sendMessage(cfg.telegramToken, chatId, `❌ Не удалось удалить подписку`);
}

export async function cmdUsers(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, `👥 <b>Пользователи</b>\n\nВсего: <code>${users.length}</code>`);
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, `📊 <b>Статистика OceaniaVPN</b>\n\n👥 <b>Пользователей:</b> <code>${users.length}</code>\n📁 <b>Файлов:</b> <code>${users.length}</code>`);
}

export async function handleCallback(cfg, cb) {
  const chatId = cb.message.chat.id;
  await answerCallback(cfg.telegramToken, cb.id);
  if (cb.data === "menu") await cmdStart(cfg, chatId);
  else if (cb.data === "create") { await setState(cfg, chatId, { step: "title" }); await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); }
  else if (cb.data === "decode") await sendMessage(cfg.telegramToken, chatId, `🔍 <b>Режим декодирования</b>\n\nОтправь мне URL подписки или используй:\n<code>/decode https://...</code>\n\nЯ маскируюсь под <b>Happ</b> 🥷 и расшифрую:\n✅ YAML (Clash/Mihomo)\n✅ JSON (Xray/Sing-box/Hiddify)\n✅ Base64\n✅ VLESS/VMess/Trojan списки`, { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  else if (cb.data === "my") await cmdMy(cfg, chatId);
  else if (cb.data === "list") await cmdList(cfg, chatId, 0);
  else if (cb.data.indexOf("list_page_") === 0) { const page = parseInt(cb.data.substring("list_page_".length), 10) || 0; await cmdList(cfg, chatId, page); }
  else if (cb.data === "delsrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Удаление сервера</b>\n\nСмотри номер в /list, затем:\n<code>/delete N</code>\n\nНапример: <code>/delete 3</code>`);
  else if (cb.data === "replacesrv_prompt") await sendMessage(cfg.telegramToken, chatId, `🔁 <b>Замена сервера</b>\n\nСмотри номер в /list, затем:\n<code>/replace N новая_ссылка</code>\n\nНапример: <code>/replace 3 vless://...</code>`);
  else if (cb.data === "add_prompt") await sendMessage(cfg.telegramToken, chatId, `➕ <b>Добавить сервер</b>\n<i>Один сервер или целую подписку</i>\n\nОтправь мне:\n• <code>vless://...</code>\n• <code>vmess://...</code>\n• <code>trojan://...</code>\n• или URL подписки <code>https://...</code>\n\nЯ добавлю конфигурацию и сразу проверю доступность.`, { inline_keyboard: [[{ text: "↩️ Назад к подписке", callback_data: "my" }], [{ text: "🏠 Главное меню", callback_data: "menu" }]] });
  else if (cb.data === "export") await cmdExport(cfg, chatId);
  else if (cb.data === "theme_pick") {
    const { pageUrl } = userUrls(cfg, chatId);
    const themeUrl = (themeId = null) => {
      try {
        const u = new URL(pageUrl);
        if (themeId) u.searchParams.set("theme", themeId);
        return u.toString();
      } catch {
        return themeId ? `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}theme=${encodeURIComponent(themeId)}` : pageUrl;
      }
    };
    const kb = { inline_keyboard: [] };
    for (let i = 0; i < THEME_LIST.length; i += 2) {
      kb.inline_keyboard.push(THEME_LIST.slice(i, i + 2).map(t => ({ text: t.label, url: themeUrl(t.id) })));
    }
    kb.inline_keyboard.push([{ text: "🎲 Случайная тема", url: themeUrl() }]);
    kb.inline_keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
    await sendMessage(cfg.telegramToken, chatId, `🖼 <b>Оформление страницы</b>\n<i>Выбери тему — откроется именно она, без случайной замены.</i>\n\n${THEME_LIST.map(t => `${t.label}`).join("  ·  ")}`, kb);
  }
  else if (cb.data === "delete") await sendMessage(cfg.telegramToken, chatId, `⚠️ <b>Удалить всю подписку?</b>\n\nЭто действие удалит твою текущую подписку целиком. Серверы можно будет добавить заново.`, { inline_keyboard: [[{ text: "🗑 Да, удалить", callback_data: "delete_confirm" }], [{ text: "↩️ Отмена", callback_data: "my" }]] });
  else if (cb.data === "delete_confirm") await cmdDelete(cfg, chatId);
  else if (cb.data === "save_alive") { const cached = await cfg.kv.get(`pingcache_${chatId}`, "json"); if (!cached || !cached.uris?.length) await sendMessage(cfg.telegramToken, chatId, `⌛ <b>Список рабочих серверов устарел</b>\n\nЗапусти /decode заново.`); else { const userFile = `user_${chatId}.txt`; const content = buildFile({ title: cached.title, interval: 4 }, cached.uris); const res = await createOrUpdateFile(cfg, userFile, content, `Save ${cached.uris.length} alive servers`); if (res.content || res.sha) { const { subUrl: aliveSubUrl, pageUrl: alivePageUrl } = userUrls(cfg, chatId); await sendMessage(cfg.telegramToken, chatId, `✅ <b>Подписка сохранена!</b>\n\n🟢 Только рабочие серверы: <code>${cached.uris.length}</code>\n🔗 <code>${aliveSubUrl}</code>`, { inline_keyboard: [[{ text: "🔗 Ссылка подписки", url: aliveSubUrl }], [{ text: "🎨 Страница подписки", url: alivePageUrl }], [{ text: "📋 Моя подписка", callback_data: "my" }]] }); } else await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`); } }
  else if (cb.data === "help") await cmdHelp(cfg, chatId);
}

export async function handleMessage(cfg, msg) {
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
  if (cmd === "/add") return cmdAdd(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/replace") return cmdReplaceServer(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/delete") { if (parts.length > 1) return cmdDeleteServer(cfg, chatId, parts[1]); return cmdDelete(cfg, chatId); }
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
}