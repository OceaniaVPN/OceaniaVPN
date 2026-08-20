// ==========================================
// ИМПОРТЫ МОДУЛЕЙ
// ==========================================
import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";
import { COUNTRIES } from "./contries.js";

// ==========================================
// КОНФИГУРАЦИЯ АВТО-ОБНОВЛЕНИЯ (МНОЖЕСТВЕННЫЕ ИСТОЧНИКИ)
// ==========================================
const AUTO_UPDATE_CONFIG = {
  sourcesFileUrl: "https://raw.githubusercontent.com/OceaniaVPN/StekloVPN/main/configs/sources.txt",
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: true,
  fallbackSources: [
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/Vless-Reality-White-Lists-Rus-Mobile.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-CIDR-RU-all.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads"
  ]
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

// Извлечение UID для фильтрации дубликатов
function extractUid(uri) {
  const match = uri.match(/^[a-z0-9]+:\/\/([a-f0-9\-]{36})@/i);
  return match ? match[1] : uri;
}

// Скачивание, объединение и фильтрация дубликатов по UID
async function fetchAndMergeSources(sourcesUrls) {
  const allUris = [];
  
  for (const url of sourcesUrls) {
    try {
      const res = await fetch(url.trim(), { method: "GET" });
      if (res.ok) {
        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(trimmed)) {
            allUris.push(trimmed);
          }
        }
      }
    } catch (e) {
      console.error(`[Commands] Failed to fetch ${url}:`, e.message);
    }
  }
  
  // Фильтрация дубликатов
  const seenUids = new Set();
  const uniqueUris = [];
  
  for (const uri of allUris) {
    const uid = extractUid(uri);
    if (!seenUids.has(uid)) {
      seenUids.add(uid);
      uniqueUris.push(uri);
    }
  }
  
  return uniqueUris;
}

// Функция для получения верхнего индекса
function getSuperscript(n) {
  const sup = [
    '', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', 
    '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'
  ];
  return n <= 20 ? sup[n] : `#${n}`;
}

// Функция переименования серверов с добавлением флагов и стран
function applyRename(uris) {
  const counters = {};
  
  COUNTRIES.forEach(c => {
    counters[c.name] = 0;
  });
  counters["Рандом"] = 0;

  return uris.map((uri) => {
    const hashIndex = uri.lastIndexOf('#');
    const baseUri = hashIndex === -1 ? uri : uri.substring(0, hashIndex);
    const originalName = hashIndex === -1 ? "" : decodeURIComponent(uri.substring(hashIndex + 1)).toLowerCase();

    let country = null;
    
    for (const c of COUNTRIES) {
      if (c.keys.some(key => originalName.includes(key))) {
        country = c;
        break;
      }
    }
    
    if (!country) {
      const hostMatch = baseUri.match(/@([^:/]+)/);
      if (hostMatch) {
        const host = hostMatch[1].toLowerCase();
        for (const c of COUNTRIES) {
          if (c.keys.some(key => host.includes(key))) {
            country = c;
            break;
          }
        }
      }
    }

    let displayName, flag, counterKey;
    if (country) {
      flag = country.flag;
      displayName = country.name;
      counterKey = country.name;
    } else {
      flag = "🌍";
      displayName = "Рандом";
      counterKey = "Рандом";
    }

    counters[counterKey]++;
    const index = counters[counterKey];
    const superscript = getSuperscript(index);

    const newName = `${flag} ${displayName} | БС${superscript}`;
    return `${baseUri}#${encodeURIComponent(newName)}`;
  });
}

// ==========================================
// ОСНОВНЫЕ КОМАНДЫ И ЛОГИКА
// ==========================================

async function manualUpdate(cfg, chatId) {
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Эта команда доступна только администратору.");
  }

  const { sourcesFileUrl, fallbackSources, targetFilename, title, interval, webpage, announce, userinfo, doRename } = AUTO_UPDATE_CONFIG;
  
  await sendMessage(cfg.telegramToken, chatId, "⏳ <b>Обновляю подписку...</b>\n\nСкачиваю источники и фильтрую дубликаты по UID...");

  try {
    let sourcesToUse = fallbackSources;
    
    // Пытаемся загрузить источники из твоего файла на GitHub
    try {
      const res = await fetch(sourcesFileUrl, { method: "GET" });
      if (res.ok) {
        const text = await res.text();
        const lines = text.split("\n").map(l => l.trim()).filter(l => l && l.startsWith("http"));
        if (lines.length > 0) {
          sourcesToUse = lines;
        }
      }
    } catch (e) {
      console.log("[Commands] Fallback to default sources due to error:", e.message);
    }

    // Скачиваем, объединяем и фильтруем
    const uniqueUris = await fetchAndMergeSources(sourcesToUse);
    
    if (uniqueUris.length === 0) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось получить серверы из источников.");
    }

    let finalUris = uniqueUris;
    if (doRename) {
      finalUris = applyRename(finalUris);
    }

    const profileMetadata = { title, interval, webpage, announce, userinfo };
    const content = buildFile(profileMetadata, finalUris);
    const saveResult = await createOrUpdateFile(cfg, targetFilename, content, "Manual update: " + finalUris.length + " unique nodes");

    if (saveResult.content || saveResult.sha) {
      const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${targetFilename}`;
      
      const keyboard = { 
        inline_keyboard: [[{ text: "🔄 Обновить ещё раз", callback_data: "manual_update" }]] 
      };
      
      await sendMessage(
        cfg.telegramToken, 
        chatId,
        `✅ <b>Подписка обновлена!</b>\n\n📡 Уникальных серверов: <code>${finalUris.length}</code>\n📁 Файл: <code>${targetFilename}</code>\n🔗 <a href="${rawUrl}">Открыть</a>`,
        keyboard
      );
    } else {
      await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка сохранения в GitHub: " + (saveResult.message || "неизвестно"));
    }
  } catch (e) {
    await sendMessage(cfg.telegramToken, chatId, "💥 Ошибка: " + e.message);
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
  const userFile = `user_${chatId}.txt`;
  const content = buildFile(state, uris);
  const res = await createOrUpdateFile(cfg, userFile, content, `Subscription for user ${chatId}`);
  await clearState(cfg, chatId);
  
  if (res.content || res.sha) {
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
    
    const kb = { 
      inline_keyboard: [
        [{ text: "📋 Моя подписка", callback_data: "my" }], 
        [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }], 
        [{ text: "🗑 Удалить", callback_data: "delete" }]
      ] 
    };
    
    await sendMessage(
      cfg.telegramToken, 
      chatId, 
      `✅ <b>Подписка создана!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов:</b> <code>${uris.length}</code>\n🔗 <b>Raw ссылка:</b>\n<code>${rawUrl}</code>\n━━━━━━━━━━━━━━━━━━━━`, 
      kb
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка: " + (res.message || "неизвестно"));
  }
}

// ==========================================
// ЭКСПОРТИРУЕМЫЕ КОМАНДЫ БОТА
// ==========================================

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);
  
  const kb = { 
    inline_keyboard: [
      [{ text: "✨ Создать подписку", callback_data: "create" }, { text: "🔍 Декодер", callback_data: "decode" }], 
      [{ text: "📋 Моя подписка", callback_data: "my" }, { text: "📤 Экспорт", callback_data: "export" }], 
      [{ text: "🔄 Обновить whitelist", callback_data: "manual_update" }], 
      [{ text: "ℹ️ Помощь", callback_data: "help" }]
    ] 
  };
  
  await sendMessage(
    cfg.telegramToken, 
    chatId, 
    "🌊 <b>OceaniaVPN Bot</b>\n\n👋 <b>Привет!</b>\n\n✨ <b>/create</b> — создать подписку\n🔍 <b>/decode</b> — расшифровка\n➕ <b>/add</b> — добавить сервер\n📤 <b>/export</b> — raw ссылка\n🗑 <b>/delete</b> — удалить\n🔄 <b>/update</b> — обновить whitelist (только админ)", 
    kb
  );
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(
    cfg.telegramToken, 
    chatId, 
    "ℹ️ <b>Помощь</b>\n/start — меню\n/create — создать\n/decode <url> — расшифровать\n/my — моя подписка\n/export — raw ссылка\n/add <url> — добавить\n/delete — удалить\n/update — обновить whitelist (админ)\n/cancel — отмена"
  );
}

export async function cmdCreate(cfg, chatId) { 
  await setState(cfg, chatId, { step: "title" }); 
  await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); 
}

export async function cmdCancel(cfg, chatId) {
  const state = await getState(cfg, chatId);
  if (state) { 
    await clearState(cfg, chatId); 
    await sendMessage(cfg.telegramToken, chatId, "❌ <b>Создание отменено.</b>"); 
  } else { 
    await sendMessage(cfg.telegramToken, chatId, "ℹ️ Нет активного процесса."); 
  }
}

export async function cmdUpdate(cfg, chatId) { 
  await manualUpdate(cfg, chatId); 
}

export async function cmdDecode(cfg, chatId, url) {
  if (!url || !url.startsWith("http")) {
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/decode https://example.com/sub</code>");
  }
  
  let loadingMsgId = null;
  
  try {
    const loadingMsg = await sendMessage(cfg.telegramToken, chatId, "⏳ <b>Декодирую...</b>");
    if (loadingMsg && loadingMsg.result && loadingMsg.result.message_id) {
      loadingMsgId = loadingMsg.result.message_id;
    }
    
    const result = await decodeSubscription(url);
    
    if (!result.ok) {
      const errorMsg = "❌ <b>Не удалось расшифровать</b>\n\n" + result.error;
      if (loadingMsgId) {
        await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg);
      } else {
        await sendMessage(cfg.telegramToken, chatId, errorMsg);
      }
      return;
    }
    
    const uris = result.uris || [];
    const filename = `decoded_${chatId}_${Date.now().toString(36)}.txt`;
    const content = buildFile({ title: "Decoded", interval: 4, webpage: url, announce: null }, uris);
    const res = await createOrUpdateFile(cfg, filename, content, "Decode");
    
    if (!(res.content || res.sha)) {
      if (loadingMsgId) {
        await editMessage(cfg.telegramToken, chatId, loadingMsgId, "❌ Ошибка сохранения");
      } else {
        await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка сохранения");
      }
      return;
    }
    
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${filename}`;
    const kb = { inline_keyboard: [[{ text: "📋 Открыть", url: rawUrl }]] };
    const successMsg = `✅ <b>Успешно!</b>\n\n📡 Серверов: <code>${uris.length}</code>\n🔗 <code>${rawUrl}</code>`;
    
    if (loadingMsgId) {
      await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb);
    } else {
      await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
    }
  } catch (err) {
    await sendMessage(cfg.telegramToken, chatId, "⚠️ Ошибка: " + err.message);
  }
}

export async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Подписки нет. Используй /create");
  }
  
  const lines = content.split("\n");
  const headers = lines.filter(l => l.startsWith("#"));
  const links = lines.filter(l => l.trim() && !l.startsWith("#"));
  
  const msg = `📋 <b>Твоя подписка</b>\n\n<b>Заголовки:</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>\n<b>Серверов:</b> <code>${links.length}</code>`;
  const kb = { 
    inline_keyboard: [
      [{ text: "📤 Экспорт", callback_data: "export" }], 
      [{ text: "🗑 Удалить", callback_data: "delete" }]
    ] 
  };
  
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
  }
  
  const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/user_${chatId}.txt`;
  const kb = { inline_keyboard: [[{ text: "🔗 Открыть", url: rawUrl }]] };
  
  await sendMessage(cfg.telegramToken, chatId, `📤 <b>Экспорт</b>\n\n🔗 <code>${rawUrl}</code>`, kb);
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) {
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/add vless://...</code>");
  }
  
  const userFile = `user_${chatId}.txt`;
  const existing = await getFileContent(cfg, userFile);
  if (!existing) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
  }
  
  const lines = existing.split("\n");
  const headers = lines.filter(l => l.startsWith("#") || l.trim() === "");
  const links = lines.filter(l => !l.startsWith("#") && l.trim() !== "");
  
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) {
    const result = await decodeSubscription(url);
    if (result.ok && result.uris && result.uris.length > 0) {
      toAdd = result.uris;
    } else {
      return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось декодировать: " + result.error);
    }
  }
  
  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, "Add nodes");
  
  if (res.content || res.sha) {
    await sendMessage(cfg.telegramToken, chatId, `✅ Добавлено: <code>${toAdd.length}</code>. Всего: <code>${links.length}</code>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка");
  }
}

export async function cmdDelete(cfg, chatId) {
  const res = await deleteFile(cfg, `user_${chatId}.txt`, "Delete");
  if (res.commit) {
    await sendMessage(cfg.telegramToken, chatId, "🗑 Подписка удалена");
  } else {
    await sendMessage(cfg.telegramToken, chatId, "📭 У тебя нет подписки");
  }
}

export async function cmdUsers(cfg, chatId, userId) {
  if (userId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  }
  
  const users = await listAllUsers(cfg);
  if (users.length === 0) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Пользователей нет");
  }
  
  let msg = `👥 <b>Пользователей:</b> <code>${users.length}</code>\n\n`;
  for (const f of users.slice(0, 50)) {
    msg += `🔹 <code>${f.replace("user_", "").replace(".txt", "")}</code>\n`;
  }
  
  await sendMessage(cfg.telegramToken, chatId, msg);
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  }
  
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, `📊 <b>Статистика</b>\n\n👥 Пользователей: <code>${users.length}</code>`);
}

// ==========================================
// ОБРАБОТЧИКИ СОБЫТИЙ TELEGRAM
// ==========================================

export async function handleCallback(cfg, cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from ? cb.from.id : chatId;
  await answerCallback(cfg.telegramToken, cb.id);
  
  if (cb.data === "create") { 
    await setState(cfg, chatId, { step: "title" }); 
    await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title); 
  } 
  else if (cb.data === "decode") { 
    await sendMessage(cfg.telegramToken, chatId, "🔍 Отправь URL подписки или используй <code>/decode https://...</code>"); 
  } 
  else if (cb.data === "my") { 
    await cmdMy(cfg, chatId); 
  } 
  else if (cb.data === "export") { 
    await cmdExport(cfg, chatId); 
  } 
  else if (cb.data === "delete") { 
    await cmdDelete(cfg, chatId); 
  } 
  else if (cb.data === "help") { 
    await cmdHelp(cfg, chatId); 
  } 
  else if (cb.data === "manual_update") {
    if (userId !== cfg.adminId) {
      await sendMessage(cfg.telegramToken, chatId, "⛔️ Эта кнопка только для администратора.");
    } else {
      await manualUpdate(cfg, chatId);
    }
  }
}

export async function handleMessage(cfg, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const state = await getState(cfg, chatId);
  
  if (state && state.step && !text.startsWith("/")) { 
    await handleStepAnswer(cfg, chatId, text, state); 
    return; 
  }
  
  if (!text.startsWith("/") && /^https?:\/\//.test(text.trim())) { 
    await cmdDecode(cfg, chatId, text.trim()); 
    return; 
  }
  
  if (!text.startsWith("/")) {
    return;
  }
  
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const userId = msg.from.id;
  
  if (cmd === "/start") return cmdStart(cfg, chatId);
  if (cmd === "/help") return cmdHelp(cfg, chatId);
  if (cmd === "/create") return cmdCreate(cfg, chatId);
  if (cmd === "/decode") return cmdDecode(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/my") return cmdMy(cfg, chatId);
  if (cmd === "/export") return cmdExport(cfg, chatId);
  if (cmd === "/add") return cmdAdd(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/delete") return cmdDelete(cfg, chatId);
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/update") return cmdUpdate(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
        }
