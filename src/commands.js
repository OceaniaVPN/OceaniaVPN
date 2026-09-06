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

// Определяет страну сервера по названию (после #) или по хосту в самой ссылке —
// использует общую логику матчинга из contries.js (учитывает границы слов
// для коротких ISO-кодов, чтобы "ro" не матчился внутри "provider").
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

// 🔗 Единая точка сборки ссылок пользователя — обе ведут на файл user_<chatId>.txt,
// просто через разные роуты воркера (/sub отдаёт сам файл подписки для VPN-клиента,
// /page — тематическую HTML-страницу со статусом для человека). Раньше эта функция
// вызывалась в 4 местах, но нигде не была определена — из-за этого падало создание
// подписки, /my, /export и кнопка "Сохранить рабочие".
function userUrls(cfg, chatId) {
  return {
    subUrl: `${cfg.workerOrigin}/sub?u=${chatId}`,
    pageUrl: `${cfg.workerOrigin}/page?u=${chatId}`,
  };
}

function mainMenu() {
  return {
    inline_keyboard: [
      [
        { text: "✨ Создать подписку", callback_data: "create" },
        { text: "🔍 Декодер", callback_data: "decode" },
      ],
      [
        { text: "📋 Моя подписка", callback_data: "my" },
        { text: "📡 Серверы", callback_data: "list" },
      ],
      [
        { text: "📤 Экспорт", callback_data: "export" },
        { text: "ℹ️ Помощь", callback_data: "help" },
      ],
    ],
  };
}

function backToMenuKeyboard() {
  return { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] };
}

// Список тем — дублирует AVAILABLE_THEMES из index.js (там же лежат сами файлы
// temi/*.html). Импортировать оттуда нельзя — index.js сам импортирует
// handleCallback из этого файла, получился бы циклический импорт.
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
      `✅ <b>Подписка создана!</b>

━━━━━━━━━━━━━━━━━━━━
📡 <b>Серверов:</b> <code>${uris.length}</code>
🔗 <b>Ссылка подписки:</b>
<code>${subUrl}</code>
━━━━━━━━━━━━━━━━━━━━

💡 <b>Импортируй в:</b>
• v2rayNG → Подписка → +
• Hiddify → Добавить профиль
• Shadowrocket → + → Тип: Subscribe`,
      kb
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
  }
}

// ═══════ КОМАНДЫ ═══════

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);

  const kb = mainMenu();

  await sendMessage(
    cfg.telegramToken, chatId,
    `━━━━━━━━━━━━━━━━━━━━━━━
🌊 <b>OceaniaVPN</b>
━━━━━━━━━━━━━━━━━━━━━━━

👋 <b>Добро пожаловать!</b>
Твой личный центр управления VPN-подпиской.

<b>🚀 Быстрый доступ</b>
✨ Создать новую подписку
🔍 Декодировать готовую
📋 Проверить свою подписку
📡 Посмотреть серверы и их статус

<i>Выбери действие — всё остальное сделаем за тебя.</i>`,
    kb
  );
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(
    cfg.telegramToken, chatId,
    `ℹ️ <b>Помощь OceaniaVPN</b>
━━━━━━━━━━━━━━━━━━━━━━━

<b>📋 Основные команды</b>
━━━━━━━━━━━━━━━━━━━━━━━
/start — главное меню
/create — создать подписку
/decode &lt;url&gt; — расшифровать
/my — показать мою подписку
/list — список серверов с названиями стран
/replace N &lt;ссылка&gt; — заменить сервер №N
/export — получить raw ссылку
/add &lt;url&gt; — добавить сервер
/delete N — удалить сервер №N
/delete — удалить всю подписку
/cancel — отменить создание

━━━━━━━━━━━━━━━━━━━━━━━
<b>🔍 Форматы декодера</b>
━━━━━━━━━━━━━━━━━━━━━━━
✅ <b>YAML</b> — Clash / Mihomo / Metacubex
✅ <b>JSON</b> — Xray / Sing-box / Hiddify / V2RayTun
✅ <b>Base64</b> — стандартные v2ray подписки
✅ <b>Plain text</b> — список vless://vmess://...
✅ <b>Happ redirect</b> — HTML страницы с кнопкой
⚠️ <b>crypt5/crypt4</b> — нужно открыть в Happ и экспортировать

━━━━━━━━━━━━━━━━━━━━━━━
<b>📱 Поддерживаемые протоколы</b>
━━━━━━━━━━━━━━━━━━━━━━━
• VLESS (xtls-vision, reality)
• VMess
• Trojan
• Shadowsocks
• Hysteria / Hysteria2
• Tuic
• WireGuard`
  , backToMenuKeyboard());
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
  if (!url || !url.startsWith("http")) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>
<code>/decode https://example.com/sub</code>

Или просто отправь URL сообщением.`);
  }

  let loadingMsgId = null;

  try {
    const loadingMsg = await sendMessage(
      cfg.telegramToken, chatId,
      `⏳ <b>Декодирую подписку...</b>

🔗 URL: <code>${escapeHtml(url.substring(0, 60))}...</code>
🥷 Маскируюсь под <b>Happ</b>
🔍 Определяю формат...`
    );

    if (loadingMsg?.result?.message_id) {
      loadingMsgId = loadingMsg.result.message_id;
    }

    const result = await decodeSubscription(url, false, true);

    if (!result.ok) {
      const errorMsg = `❌ <b>Не удалось расшифровать</b>\n\n${result.error}`;
      if (loadingMsgId) {
        await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg);
      } else {
        await sendMessage(cfg.telegramToken, chatId, errorMsg);
      }
      return;
    }

    if (loadingMsgId) {
      await editMessage(cfg.telegramToken, chatId, loadingMsgId,
        `⏳ <b>Формат определён</b>\n\n📡 Найдено серверов: <code>${(result.uris || []).length}</code>\n🟢 Проверяю, какие реально работают (пинг)...`);
    }

    const uris = result.uris || [];
    const timestamp = Date.now().toString(36);
    const filename = `decoded_${chatId}_${timestamp}.txt`;
    const meta = result.metadata || {};
    let hostname = "subscription";
    try { hostname = new URL(url).hostname; } catch {}

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

    // Декодированный файл тоже отдаём через воркер (/sub?f=filename), не через GitHub напрямую
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

    // 🟢🔴 Результат пинга: сколько из найденных серверов реально живые.
    const aliveFlags = result.aliveFlags || [];
    const aliveCount = result.aliveCount ?? aliveFlags.filter(Boolean).length;
    const deadCount = result.deadCount ?? (aliveFlags.length - aliveCount);
    const aliveUris = uris.filter((_, i) => aliveFlags[i]);

    const kb = { inline_keyboard: [[{ text: "📋 Открыть подписку", url: rawUrl }]] };
    if (aliveFlags.length > 0 && deadCount > 0 && aliveCount > 0) {
      // Кнопка появляется только если пинг реально что-то отсеял — сохраняем
      // список живых на 10 минут в KV, чтобы не гонять пинг повторно при клике.
      await cfg.kv.put(`pingcache_${chatId}`, JSON.stringify({ uris: aliveUris, title: meta["profile-title"] || `Decoded • ${hostname}` }), { expirationTtl: 600 });
      kb.inline_keyboard.push([{ text: `✅ Сохранить только рабочие (${aliveCount})`, callback_data: "save_alive" }]);
    }

    const pingLine = aliveFlags.length > 0
      ? `\n🟢 <b>Рабочих:</b> <code>${aliveCount}</code> · 🔴 <b>Не отвечают:</b> <code>${deadCount}</code>\n`
      : "";

    const successMsg = `✅ <b>Успешно расшифровано!</b>

━━━━━━━━━━━━━━━━━━━━
📡 <b>Серверов найдено:</b> <code>${uris.length}</code>
${pingLine}
<b>Протоколы:</b>
${stats.vless ? `• VLESS: <b>${stats.vless}</b>\n` : ""}` +
      `${stats.vmess ? `• VMess: <b>${stats.vmess}</b>\n` : ""}` +
      `${stats.trojan ? `• Trojan: <b>${stats.trojan}</b>\n` : ""}` +
      `${stats.ss ? `• Shadowsocks: <b>${stats.ss}</b>\n` : ""}` +
      `${stats.hysteria ? `• Hysteria: <b>${stats.hysteria}</b>\n` : ""}` +
      `${stats.other ? `• Другое: <b>${stats.other}</b>\n` : ""}` +
      `
🔗 <b>Raw ссылка:</b>
<code>${rawUrl}</code>
━━━━━━━━━━━━━━━━━━━━

💡 Вставь в v2rayNG / Hiddify / Shadowrocket`;

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
      `📭 <b>Подписки нет</b>\n\nСоздай через /create или расшифруй через /decode`);
  }

  const { headers, links } = splitSubscriptionFile(content);

  const msg = `📋 <b>Твоя подписка</b>
━━━━━━━━━━━━━━━━━━━━━━━

🟢 <b>Статус:</b> активна
📡 <b>Серверов:</b> <code>${links.length}</code>

<b>⚙️ Параметры</b>
<pre>${escapeHtml(headers.join("\n"))}</pre>`;

  const { subUrl: mySubUrl, pageUrl: myPageUrl } = userUrls(cfg, chatId);
  const kb = {
    inline_keyboard: [
      [{ text: "🎨 Страница подписки", url: myPageUrl }, { text: "🖼 Сменить тему", callback_data: "theme_pick" }],
      [{ text: "📡 Список серверов", callback_data: "list" }],
      [{ text: "📤 Экспорт", callback_data: "export" }],
      [{ text: "🗑 Удалить подписку", callback_data: "delete" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }],
    ]
  };

  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

// 📡 Пронумерованный список всех серверов подписки с определением страны
// (по названию сервера после # или по хосту), постранично по 20 штук.
export async function cmdList(cfg, chatId, page = 0) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId,
      `📭 <b>Подписки нет</b>\n\nСоздай через /create или расшифруй через /decode`);
  }

  const { links } = splitSubscriptionFile(content);
  if (links.length === 0) {
    return sendMessage(cfg.telegramToken, chatId, `📭 В подписке пока нет серверов. Добавь через /add`);
  }

  const PER_PAGE = 20;
  const totalPages = Math.max(1, Math.ceil(links.length / PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PER_PAGE;
  const pageLinks = links.slice(start, start + PER_PAGE);

  // 🟢🔴 Пингуем именно эту страницу (до 20 серверов) в реальном времени —
  // "если человек заходит в сервер лист, видит что у него не работает".
  const aliveFlags = await checkServersAlive(pageLinks, { concurrency: 8, timeoutMs: 2000 });

  let msg = `📡 <b>Серверы подписки</b>\nВсего: <code>${links.length}</code> · Страница <code>${safePage + 1}/${totalPages}</code>\n\n`;
  pageLinks.forEach((uri, i) => {
    const num = start + i + 1;
    const country = detectCountry(uri);
    const label = country ? `${country.flag} ${country.name}` : "🌍 Неизвестно";
    const status = aliveFlags[i] ? "🟢" : "🔴";
    msg += `<b>${num}.</b> ${status} ${label} <i>(${protocolOf(uri)})</i>\n`;
  });
  msg += `\n💡 <code>/delete N</code> — удалить сервер\n💡 <code>/replace N ссылка</code> — заменить сервер`;

  const navRow = [];
  if (safePage > 0) navRow.push({ text: "⬅️ Назад", callback_data: `list_page_${safePage - 1}` });
  if (safePage < totalPages - 1) navRow.push({ text: "Далее ➡️", callback_data: `list_page_${safePage + 1}` });

  const kb = { inline_keyboard: [] };
  if (navRow.length) kb.inline_keyboard.push(navRow);
  kb.inline_keyboard.push([
    { text: "🗑 Как удалить", callback_data: "delsrv_prompt" },
    { text: "🔁 Как заменить", callback_data: "replacesrv_prompt" },
  ]);
  kb.inline_keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);

  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create или /decode`);

  const { subUrl: expSubUrl, pageUrl: expPageUrl } = userUrls(cfg, chatId);
  const kb = { inline_keyboard: [
    [{ text: "🔗 Ссылка подписки", url: expSubUrl }],
    [{ text: "🎨 Страница подписки", url: expPageUrl }],
  ]};

  await sendMessage(
    cfg.telegramToken, chatId,
    `📤 <b>Экспорт подписки</b>

━━━━━━━━━━━━━━━━━━━━
🔗 <b>Ссылка подписки:</b>
<code>${expSubUrl}</code>
━━━━━━━━━━━━━━━━━━━━

<b>Импортируй в:</b>
• <b>v2rayNG</b> → Подписка → +
• <b>Hiddify</b> → Добавить профиль
• <b>Shadowrocket</b> → + → Тип: Subscribe
• <b>Clash Meta</b> → Profile → Add`,
    kb
  );
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>\n<code>/add vless://...</code>`);
  }

  const userFile = `user_${chatId}.txt`;
  const existing = await getFileContent(cfg, userFile);
  if (!existing) return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create`);

  const { headers, links } = splitSubscriptionFile(existing);

  let toAdd = [url];
  if (/^https?:\/\//.test(url)) {
    const result = await decodeSubscription(url);
    if (result.ok && result.uris?.length > 0) toAdd = result.uris;
    else return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось декодировать: ${result.error}`);
  } else if (!url.includes("://")) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Не похоже на VPN ссылку.`);
  }

  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, `Add ${toAdd.length} nodes`);

  if (res.content || res.sha) {
    // 🟢🔴 Пингуем только то, что добавили, чтобы сразу показать результат.
    const aliveFlags = await checkServersAlive(toAdd, { concurrency: 8, timeoutMs: 2000 });
    const aliveCount = aliveFlags.filter(Boolean).length;
    const deadCount = aliveFlags.length - aliveCount;
    const pingLine = toAdd.length > 1
      ? `\n🟢 Рабочих: <code>${aliveCount}</code> · 🔴 Не отвечают: <code>${deadCount}</code>`
      : `\n${aliveFlags[0] ? "🟢 Сервер отвечает" : "🔴 Сервер не отвечает (добавлен, но может не работать)"}`;
    await sendMessage(cfg.telegramToken, chatId,
      `✅ <b>Добавлено серверов:</b> <code>${toAdd.length}</code>\n📊 <b>Всего:</b> <code>${links.length}</code>${pingLine}`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка`);
  }
}

// 🗑 Удаление ОДНОГО сервера по номеру (номер берётся из /list).
// Команда /delete без номера по-прежнему удаляет всю подписку (см. cmdDelete ниже) —
// этот роутинг настроен в handleMessage.
export async function cmdDeleteServer(cfg, chatId, arg) {
  const n = parseInt(arg, 10);
  if (!n || n < 1) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>\n<code>/delete N</code>\n\nНомер сервера смотри в /list. Чтобы удалить всю подписку — просто <code>/delete</code> без номера.`);
  }

  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет.`);

  const { headers, links } = splitSubscriptionFile(content);
  if (n > links.length) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Сервера №${n} не существует. Всего серверов: <code>${links.length}</code>`);
  }

  const removedCountry = detectCountry(links[n - 1]);
  links.splice(n - 1, 1);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, `Delete server #${n}`);

  if (res.content || res.sha) {
    await sendMessage(cfg.telegramToken, chatId,
      `🗑 <b>Сервер №${n} удалён</b>${removedCountry ? ` (${removedCountry.flag} ${removedCountry.name})` : ""}\nОсталось серверов: <code>${links.length}</code>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка удаления`);
  }
}

// 🔁 Замена сервера по номеру: /replace N <новая ссылка или URL подписки>.
// Если вторым аргументом дан http(s)-URL — сам декодируется, берётся первый
// найденный сервер (для замены нужен ровно один).
export async function cmdReplaceServer(cfg, chatId, argString) {
  const trimmed = (argString || "").trim();
  const firstSpace = trimmed.indexOf(" ");
  const nRaw = firstSpace === -1 ? trimmed : trimmed.substring(0, firstSpace);
  const newUrl = firstSpace === -1 ? "" : trimmed.substring(firstSpace + 1).trim();
  const n = parseInt(nRaw, 10);

  if (!n || n < 1 || !newUrl) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>\n<code>/replace N новая_ссылка</code>\n\nНомер сервера смотри в /list.`);
  }

  const userFile = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, userFile);
  if (!content) return sendMessage(cfg.telegramToken, chatId, `📭 Подписки нет.`);

  const { headers, links } = splitSubscriptionFile(content);
  if (n > links.length) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Сервера №${n} не существует. Всего серверов: <code>${links.length}</code>`);
  }

  let replacement = newUrl;
  if (/^https?:\/\//.test(newUrl)) {
    const result = await decodeSubscription(newUrl);
    if (result.ok && result.uris?.length > 0) replacement = result.uris[0];
    else return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось декодировать: ${result.error}`);
  } else if (!newUrl.includes("://")) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Не похоже на VPN ссылку.`);
  }

  links[n - 1] = replacement;
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, `Replace server #${n}`);

  if (res.content || res.sha) {
    const country = detectCountry(replacement);
    await sendMessage(cfg.telegramToken, chatId,
      `🔁 <b>Сервер №${n} заменён</b>${country ? ` (${country.flag} ${country.name})` : ""}`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка замены`);
  }
}

export async function cmdDelete(cfg, chatId) {
  const res = await deleteFile(cfg, `user_${chatId}.txt`, `Delete user ${chatId}`);
  if (res.commit) await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Подписка удалена</b>`);
  else await sendMessage(cfg.telegramToken, chatId, `📭 У тебя нет подписки`);
}

export async function cmdUsers(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);

  const users = await listAllUsers(cfg);
  if (users.length === 0) return sendMessage(cfg.telegramToken, chatId, `📭 Пользователей нет`);

  let msg = `👥 <b>Пользователей:</b> <code>${users.length}</code>\n\n`;
  for (const f of users.slice(0, 50)) {
    const id = f.replace("user_", "").replace(".txt", "");
    msg += `🔹 <code>${id}</code>\n`;
  }
  await sendMessage(cfg.telegramToken, chatId, msg);
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId,
    `📊 <b>Статистика OceaniaVPN</b>\n\n👥 <b>Пользователей:</b> <code>${users.length}</code>\n📁 <b>Файлов:</b> <code>${users.length}</code>`);
}

// ═══════ CALLBACK ОБРАБОТКА ═══════

export async function handleCallback(cfg, cb) {
  const chatId = cb.message.chat.id;
  await answerCallback(cfg.telegramToken, cb.id);

  if (cb.data === "menu") {
    await cmdStart(cfg, chatId);
  } else if (cb.data === "create") {
    await setState(cfg, chatId, { step: "title" });
    await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
  } else if (cb.data === "decode") {
    await sendMessage(cfg.telegramToken, chatId,
      `🔍 <b>Режим декодирования</b>

Отправь мне URL подписки или используй:
<code>/decode https://...</code>

Я маскируюсь под <b>Happ</b> 🥷 и расшифрую:
✅ YAML (Clash/Mihomo)
✅ JSON (Xray/Sing-box/Hiddify)
✅ Base64
✅ VLESS/VMess/Trojan списки`);
  } else if (cb.data === "my") {
    await cmdMy(cfg, chatId);
  } else if (cb.data === "list") {
    await cmdList(cfg, chatId, 0);
  } else if (cb.data.indexOf("list_page_") === 0) {
    const page = parseInt(cb.data.substring("list_page_".length), 10) || 0;
    await cmdList(cfg, chatId, page);
  } else if (cb.data === "delsrv_prompt") {
    await sendMessage(cfg.telegramToken, chatId,
      `🗑 <b>Удаление сервера</b>\n\nСмотри номер в /list, затем:\n<code>/delete N</code>\n\nНапример: <code>/delete 3</code>`);
  } else if (cb.data === "replacesrv_prompt") {
    await sendMessage(cfg.telegramToken, chatId,
      `🔁 <b>Замена сервера</b>\n\nСмотри номер в /list, затем:\n<code>/replace N новая_ссылка</code>\n\nНапример: <code>/replace 3 vless://...</code>`);
  } else if (cb.data === "export") {
    await cmdExport(cfg, chatId);
  } else if (cb.data === "theme_pick") {
    const { pageUrl } = userUrls(cfg, chatId);
    const kb = { inline_keyboard: [] };
    for (let i = 0; i < THEME_LIST.length; i += 2) {
      kb.inline_keyboard.push(THEME_LIST.slice(i, i + 2).map(t => ({ text: t.label, url: `${pageUrl}&theme=${t.id}` })));
    }
    kb.inline_keyboard.push([{ text: "🏠 Главное меню", callback_data: "menu" }]);
    await sendMessage(cfg.telegramToken, chatId, `🖼 <b>Оформление страницы</b>\n\nВыбери стиль — откроется предпросмотр твоей подписки.`, kb);
  } else if (cb.data === "delete") {
    await sendMessage(cfg.telegramToken, chatId,
      `⚠️ <b>Удалить всю подписку?</b>\n\nЭто действие удалит твою текущую подписку целиком. Серверы можно будет добавить заново.`,
      { inline_keyboard: [
        [{ text: "🗑 Да, удалить", callback_data: "delete_confirm" }],
        [{ text: "↩️ Отмена", callback_data: "my" }],
      ]});
  } else if (cb.data === "delete_confirm") {
    await cmdDelete(cfg, chatId);
  } else if (cb.data === "save_alive") {
    const cached = await cfg.kv.get(`pingcache_${chatId}`, "json");
    if (!cached || !cached.uris?.length) {
      await sendMessage(cfg.telegramToken, chatId, `⌛ <b>Список рабочих серверов устарел</b>\n\nЗапусти /decode заново.`);
    } else {
      const userFile = `user_${chatId}.txt`;
      const content = buildFile({ title: cached.title, interval: 4 }, cached.uris);
      const res = await createOrUpdateFile(cfg, userFile, content, `Save ${cached.uris.length} alive servers`);
      if (res.content || res.sha) {
        const { subUrl: aliveSubUrl, pageUrl: alivePageUrl } = userUrls(cfg, chatId);
        await sendMessage(cfg.telegramToken, chatId,
          `✅ <b>Подписка сохранена!</b>\n\n🟢 Только рабочие серверы: <code>${cached.uris.length}</code>\n🔗 <code>${aliveSubUrl}</code>`,
          { inline_keyboard: [
            [{ text: "🔗 Ссылка подписки", url: aliveSubUrl }],
            [{ text: "🎨 Страница подписки", url: alivePageUrl }],
          ]});
      } else {
        await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`);
      }
    }
  } else if (cb.data === "help") {
    await cmdHelp(cfg, chatId);
  }
}

// ═══════ ОБРАБОТЧИК СООБЩЕНИЙ ═══════

export async function handleMessage(cfg, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const state = await getState(cfg, chatId);

  // FSM ответ
  if (state && state.step && !text.startsWith("/")) {
    await handleStepAnswer(cfg, chatId, text, state);
    return;
  }

  // Автоматическое декодирование URL
  if (!text.startsWith("/") && /^https?:\/\//.test(text.trim())) {
    await cmdDecode(cfg, chatId, text.trim());
    return;
  }

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
  if (cmd === "/delete") {
    // /delete N — удалить конкретный сервер; /delete без аргумента — всю подписку (как раньше)
    if (parts.length > 1) return cmdDeleteServer(cfg, chatId, parts[1]);
    return cmdDelete(cfg, chatId);
  }
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
}
