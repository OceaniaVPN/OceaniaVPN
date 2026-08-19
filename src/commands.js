import { sendMessage, editMessage, answerCallback } from "./telegram.js";
import { createOrUpdateFile, deleteFile, getFileContent, listAllUsers } from "./github.js";
import { getState, setState, clearState, STEPS, STEP_MSG } from "./state.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { escapeHtml } from "./config.js";

const AUTO_UPDATE_CONFIG = {
  targetUrl: "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: true
};

const COUNTRIES = [
  { keys: ["us", "usa", "america", "new york", "los angeles"], flag: "🇺🇸", name: "США" },
  { keys: ["ru", "russia", "moscow", "spb", "peter"], flag: "🇷🇺", name: "Россия" },
  { keys: ["de", "germany", "berlin", "frankfurt"], flag: "🇪", name: "Германия" },
  { keys: ["nl", "netherlands", "amsterdam"], flag: "🇳", name: "Нидерланды" },
  { keys: ["gb", "uk", "london", "england"], flag: "🇧", name: "Великобритания" },
  { keys: ["fr", "france", "paris"], flag: "🇫🇷", name: "Франция" },
  { keys: ["fi", "finland", "helsinki"], flag: "🇫🇮", name: "Финляндия" },
  { keys: ["kz", "kazakhstan", "almaty", "astana"], flag: "🇰🇿", name: "Казахстан" },
  { keys: ["ua", "ukraine", "kiev"], flag: "🇺🇦", name: "Украина" },
  { keys: ["jp", "japan", "tokyo"], flag: "🇯🇵", name: "Япония" },
  { keys: ["sg", "singapore"], flag: "🇸🇬", name: "Сингапур" },
  { keys: ["kr", "korea", "seoul"], flag: "🇰🇷", name: "Корея" },
  { keys: ["it", "italy", "milan", "rome"], flag: "🇮🇹", name: "Италия" },
  { keys: ["es", "spain", "madrid", "barcelona"], flag: "🇪🇸", name: "Испания" },
  { keys: ["ca", "canada", "toronto", "vancouver"], flag: "🇨", name: "Канада" },
  { keys: ["au", "australia", "sydney", "melbourne"], flag: "🇺", name: "Австралия" },
  { keys: ["br", "brazil", "sao paulo"], flag: "🇧🇷", name: "Бразилия" },
  { keys: ["in", "india", "mumbai", "delhi"], flag: "🇮🇳", name: "Индия" },
  { keys: ["tr", "turkey", "istanbul"], flag: "🇹🇷", name: "Турция" },
  { keys: ["pl", "poland", "warsaw"], flag: "🇵🇱", name: "Польша" }
];

const SUP = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹', '¹⁹', '²⁰'];

function applyRename(uris) {
  const counters = {};
  COUNTRIES.forEach(c => counters[c.name] = 0);
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

    let displayName, counterKey;
    if (country) {
      displayName = country.flag + " " + country.name;
      counterKey = country.name;
    } else {
      displayName = "Рандом";
      counterKey = "Рандом";
    }

    counters[counterKey]++;
    const index = counters[counterKey];
    const superscript = SUP[Math.min(index, 20)] || ("_" + index);

    return baseUri + "#" + encodeURIComponent(displayName + " | БС" + superscript);
  });
}

async function manualUpdate(cfg, chatId) {
  // 🔥 ПРОВЕРКА АДМИНА
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Эта команда только для администратора.");
  }

  const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, doRename } = AUTO_UPDATE_CONFIG;

  const loadingMsg = await sendMessage(
    cfg.telegramToken, chatId,
    "⏳ <b>Обновляю подписку...</b>\n\nСкачиваю серверы..."
  );

  try {
    const result = await decodeSubscription(targetUrl);

    if (!result.ok) {
      await sendMessage(cfg.telegramToken, chatId, "❌ <b>Ошибка обновления</b>\n\n" + result.error);
      return;
    }

    let finalUris = result.uris;
    if (doRename && finalUris.length > 0) {
      finalUris = applyRename(finalUris);
    }

    const profileMetadata = { title, interval, webpage, announce, userinfo };
    const content = buildFile(profileMetadata, finalUris);
    const saveResult = await createOrUpdateFile(cfg, targetFilename, content, "Manual update");

    if (saveResult.content || saveResult.sha) {
      const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + targetFilename;
      await sendMessage(
        cfg.telegramToken, chatId,
        "✅ <b>Подписка обновлена!</b>\n\n📡 Серверов: <code>" + finalUris.length + "</code>\n📁 Файл: <code>" + targetFilename + "</code>\n <a href=\"" + rawUrl + "\">Открыть</a>",
        { inline_keyboard: [[{ text: "🔄 Обновить ещё раз", callback_data: "manual_update" }]] }
      );
    } else {
      await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка сохранения в GitHub: " + (saveResult.message || "неизвестно"));
    }
  } catch (e) {
    await sendMessage(cfg.telegramToken, chatId, " Ошибка: " + e.message);
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
  const userFile = "user_" + chatId + ".txt";
  const content = buildFile(state, uris);
  const res = await createOrUpdateFile(cfg, userFile, content, "Subscription for user " + chatId);
  await clearState(cfg, chatId);
  
  if (res.content || res.sha) {
    const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + userFile;
    
    const kb = {
      inline_keyboard: [
        [{ text: "📋 Моя подписка", callback_data: "my" }],
        [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }],
        [{ text: "🗑 Удалить", callback_data: "delete" }],
      ]
    };
    
    await sendMessage(
      cfg.telegramToken, chatId,
      "✅ <b>Подписка создана!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов:</b> <code>" + uris.length + "</code>\n🔗 <b>Raw ссылка:</b>\n<code>" + rawUrl + "</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 <b>Импортируй в:</b>\n• v2rayNG → Подписка → +\n• Hiddify → Добавить профиль\n• Shadowrocket → + → Тип: Subscribe",
      kb
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка: " + (res.message || "неизвестно"));
  }
}

export async function cmdStart(cfg, chatId) {
  await clearState(cfg, chatId);
  
  const kb = {
    inline_keyboard: [
      [{ text: "✨ Создать подписку", callback_data: "create" }, { text: "🔍 Декодер", callback_data: "decode" }],
      [{ text: "📋 Моя подписка", callback_data: "my" }, { text: " Экспорт", callback_data: "export" }],
      [{ text: "🔄 Обновить whitelist", callback_data: "manual_update" }],
      [{ text: "ℹ️ Помощь", callback_data: "help" }],
    ]
  };
  await sendMessage(cfg.telegramToken, chatId, "🌊 <b>OceaniaVPN Bot</b>\n\n👋 <b>Привет!</b>\n\nСоздай персональную VPN подписку или расшифруй чужую.\n\n<b>🎯 Что я умею:</b>\n✨ <b>/create</b> — пошаговое создание\n🔍 <b>/decode</b> — расшифровка чужой подписки\n➕ <b>/add</b> — добавить сервер\n📤 <b>/export</b> — получить raw ссылку\n🗑 <b>/delete</b> — удалить подписку\n🔄 <b>/update</b> — обновить whitelist (только админ)\n\n<i>Выбери действие ниже:</i>", kb);
}

export async function cmdHelp(cfg, chatId) {
  await sendMessage(cfg.telegramToken, chatId, "ℹ️ <b>Помощь OceaniaVPN</b>\n\n<b>📋 Основные команды</b>\n/start — главное меню\n/create — создать подписку\n/decode <url> — расшифровать\n/my — показать мою подписку\n/export — получить raw ссылку\n/add <url> — добавить сервер\n/delete — удалить подписку\n/update — обновить whitelist (только админ)\n/cancel — отменить создание");
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
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/decode https://example.com/sub</code>\n\nИли просто отправь URL сообщением.");
  }
  
  let loadingMsgId = null;
  
  try {
    const loadingMsg = await sendMessage(
      cfg.telegramToken, chatId,
      "⏳ <b>Декодирую подписку...</b>\n\n URL: <code>" + escapeHtml(url.substring(0, 60)) + "...</code>\n🥷 Маскируюсь под Happ\n Определяю формат..."
    );
    
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
    const timestamp = Date.now().toString(36);
    const filename = "decoded_" + chatId + "_" + timestamp + ".txt";
    const meta = result.metadata || {};
    let hostname = "subscription";
    try { hostname = new URL(url).hostname; } catch {}
    
    const content = buildFile(
      {
        title: meta["profile-title"] || "Decoded • " + hostname,
        interval: meta["profile-update-interval"] || 4,
        webpage: meta["profile-web-page-url"] || url,
        announce: meta.announce || null,
      },
      uris
    );
    
    const res = await createOrUpdateFile(cfg, filename, content, "Decode from " + hostname);
    
    if (!(res.content || res.sha)) {
      const errorMsg = "❌ <b>Ошибка сохранения</b>\n\n" + (res.message || "неизвестно");
      if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg);
      else await sendMessage(cfg.telegramToken, chatId, errorMsg);
      return;
    }
    
    const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + filename;
    
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, hysteria: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++;
      else if (u.startsWith("vmess://")) stats.vmess++;
      else if (u.startsWith("trojan://")) stats.trojan++;
      else if (u.startsWith("ss://")) stats.ss++;
      else if (u.startsWith("hysteria")) stats.hysteria++;
      else stats.other++;
    }
    
    const kb = { inline_keyboard: [[{ text: "📋 Открыть подписку", url: rawUrl }]] };
    
    const successMsg = "✅ <b>Успешно расшифровано!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов найдено:</b> <code>" + uris.length + "</code>\n\n<b>Протоколы:</b>\n" +
      (stats.vless ? "• VLESS: <b>" + stats.vless + "</b>\n" : "") +
      (stats.vmess ? "• VMess: <b>" + stats.vmess + "</b>\n" : "") +
      (stats.trojan ? "• Trojan: <b>" + stats.trojan + "</b>\n" : "") +
      (stats.ss ? "• Shadowsocks: <b>" + stats.ss + "</b>\n" : "") +
      (stats.hysteria ? "• Hysteria: <b>" + stats.hysteria + "</b>\n" : "") +
      (stats.other ? "• Другое: <b>" + stats.other + "</b>\n" : "") +
      "\n🔗 <b>Raw ссылка:</b>\n<code>" + rawUrl + "</code>\n━━━━━━━━━━━━━━━━━━━━\n\n💡 Вставь в v2rayNG / Hiddify / Shadowrocket";
    
    if (loadingMsgId) await editMessage(cfg.telegramToken, chatId, loadingMsgId, successMsg, kb);
    else await sendMessage(cfg.telegramToken, chatId, successMsg, kb);
    
  } catch (err) {
    const errorMsg = "⚠️ <b>Ошибка декодирования</b>\n\n<code>" + escapeHtml(err.message) + "</code>\n\nПопробуй ещё раз.";
    if (loadingMsgId) {
      try { await editMessage(cfg.telegramToken, chatId, loadingMsgId, errorMsg); }
      catch { await sendMessage(cfg.telegramToken, chatId, errorMsg); }
    } else {
      await sendMessage(cfg.telegramToken, chatId, errorMsg);
    }
  }
}

export async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, "user_" + chatId + ".txt");
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, "📭 <b>Подписки нет</b>\n\nСоздай через /create или расшифруй через /decode");
  }
  
  const lines = content.split("\n");
  const headers = lines.filter(l => l.startsWith("#"));
  const links = lines.filter(l => l.trim() && !l.startsWith("#"));
  
  const msg = "📋 <b>Твоя подписка</b>\n\n<b>Заголовки:</b>\n<pre>" + escapeHtml(headers.join("\n")) + "</pre>\n<b>Серверов:</b> <code>" + links.length + "</code>";
  
  const kb = {
    inline_keyboard: [
      [{ text: " Экспорт", callback_data: "export" }],
      [{ text: "🗑 Удалить", callback_data: "delete" }],
    ]
  };
  
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, "user_" + chatId + ".txt");
  if (!content) return sendMessage(cfg.telegramToken, chatId, " Сначала /create или /decode");
  
  const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/user_" + chatId + ".txt";
  const kb = { inline_keyboard: [[{ text: " Открыть", url: rawUrl }]] };
  
  await sendMessage(cfg.telegramToken, chatId, "📤 <b>Экспорт подписки</b>\n\n━━━━━━━━━━━━━━━━━━━━\n <b>Raw ссылка:</b>\n<code>" + rawUrl + "</code>\n━━━━━━━━━━━━━━━━━━━━", kb);
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) return sendMessage(cfg.telegramToken, chatId, " <b>Используй:</b>\n<code>/add vless://...</code>");
  
  const userFile = "user_" + chatId + ".txt";
  const existing = await getFileContent(cfg, userFile);
  if (!existing) return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
  
  const lines = existing.split("\n");
  const headers = [];
  const links = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") headers.push(line);
    else links.push(line);
  }
  
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) {
    const result = await decodeSubscription(url);
    if (result.ok && result.uris && result.uris.length > 0) toAdd = result.uris;
    else return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось декодировать: " + result.error);
  } else if (!url.includes("://")) {
    return sendMessage(cfg.telegramToken, chatId, "❌ Не похоже на VPN ссылку.");
  }
  
  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  const res = await createOrUpdateFile(cfg, userFile, updated, "Add " + toAdd.length + " nodes");
  
  if (res.content || res.sha) {
    await sendMessage(cfg.telegramToken, chatId, "✅ <b>Добавлено серверов:</b> <code>" + toAdd.length + "</code>\n📊 <b>Всего:</b> <code>" + links.length + "</code>");
  } else {
    await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка");
  }
}

export async function cmdDelete(cfg, chatId) {
  const res = await deleteFile(cfg, "user_" + chatId + ".txt", "Delete user " + chatId);
  if (res.commit) await sendMessage(cfg.telegramToken, chatId, "🗑 <b>Подписка удалена</b>");
  else await sendMessage(cfg.telegramToken, chatId, "📭 У тебя нет подписки");
}

export async function cmdUsers(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  const users = await listAllUsers(cfg);
  if (users.length === 0) return sendMessage(cfg.telegramToken, chatId, "📭 Пользователей нет");
  let msg = "👥 <b>Пользователей:</b> <code>" + users.length + "</code>\n\n";
  for (const f of users.slice(0, 50)) {
    const id = f.replace("user_", "").replace(".txt", "");
    msg += " <code>" + id + "</code>\n";
  }
  await sendMessage(cfg.telegramToken, chatId, msg);
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, " <b>Статистика OceaniaVPN</b>\n\n👥 <b>Пользователей:</b> <code>" + users.length + "</code>");
}

export async function handleCallback(cfg, cb) {
  const chatId = cb.message.chat.id;
  const userId = cb.from ? cb.from.id : chatId;
  await answerCallback(cfg.telegramToken, cb.id);
  
  if (cb.data === "create") {
    await setState(cfg, chatId, { step: "title" });
    await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
  } else if (cb.data === "decode") {
    await sendMessage(cfg.telegramToken, chatId, "🔍 <b>Режим декодирования</b>\n\nОтправь мне URL подписки или используй:\n<code>/decode https://...</code>");
  } else if (cb.data === "my") {
    await cmdMy(cfg, chatId);
  } else if (cb.data === "export") {
    await cmdExport(cfg, chatId);
  } else if (cb.data === "delete") {
    await cmdDelete(cfg, chatId);
  } else if (cb.data === "help") {
    await cmdHelp(cfg, chatId);
  } else if (cb.data === "manual_update") {
    // 🔥 ПРОВЕРКА АДМИНА ДЛЯ КНОПКИ
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
  
  if (!text.startsWith("/")) return;
  
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
