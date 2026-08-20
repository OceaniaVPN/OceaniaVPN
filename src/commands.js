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
import { TARGET_USER_AGENTS } from "./useragents.js";

// ==========================================
// ОСНОВНАЯ КОНФИГУРАЦИЯ (4 источника)
// ==========================================
const AUTO_UPDATE_CONFIG = {
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: true,
  sources: [
    "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/Vless-Reality-White-Lists-Rus-Mobile.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-CIDR-RU-all.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads"
  ]
};

// ==========================================
// ВТОРАЯ КОНФИГУРАЦИЯ (Okeania - только для обновления)
// ==========================================
const SECONDARY_CONFIG = {
  targetUrl: "https://okeaniavpn.dimastekolnikov1.workers.dev/sub?token=4ffeddfb-54ec-41ad-b76d-13f3834f8d9e",
  targetFilename: "okeania_auto.txt",
  title: "OkeaniaVPN Auto",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "OkeaniaVPN Auto Update",
  userinfo: "upload=0; download=0; total=536870912000; expire=0",
  doRename: true
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

function isStub(text) {
  if (!text) {
    return true;
  }
  const stubs = [
    "0.0.0.0",
    "00000000-0000",
    "127.0.0.1",
    "localhost",
    "App not supported",
    "not supported",
    "Unsupported app"
  ];
  return stubs.some(function(s) {
    return text.includes(s);
  });
}

function getRandomItems(arr, count) {
  const shuffled = [...arr].sort(function() {
    return 0.5 - Math.random();
  });
  return shuffled.slice(0, Math.min(count, arr.length));
}

async function fetchAndMergeSources(sourcesUrls) {
  const allUris = [];
  const stats = {};
  
  for (const url of sourcesUrls) {
    try {
      console.log("[Merge] Decoding source: " + url);
      const result = await decodeSubscription(url);
      
      if (result.ok && result.uris && result.uris.length > 0) {
        allUris.push(...result.uris);
        stats[url] = result.uris.length;
        console.log("[Merge] Success: Found " + result.uris.length + " URIs");
      } else {
        stats[url] = 0;
        console.log("[Merge] Failed or empty: " + (result.error || "Unknown error"));
      }
    } catch (e) {
      console.error("[Merge] Error on " + url + ": " + e.message);
      stats[url] = 0;
    }
  }
  
  const uniqueUris = [...new Set(allUris)];
  console.log("[Merge] Total URIs: " + allUris.length + ", After dedup: " + uniqueUris.length);
  return { uris: uniqueUris, stats };
}

function getSuperscript(n) {
  const sup = [
    '', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹',
    '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'
  ];
  if (n <= 20) {
    return sup[n];
  }
  return "#" + n;
}

function applyRename(uris) {
  const counters = {};
  
  COUNTRIES.forEach(function(c) {
    counters[c.name] = 0;
  });
  counters["Рандом"] = 0;

  return uris.map(function(uri) {
    const hashIndex = uri.lastIndexOf('#');
    const baseUri = hashIndex === -1 ? uri : uri.substring(0, hashIndex);
    const originalName = hashIndex === -1 ? "" : decodeURIComponent(uri.substring(hashIndex + 1)).toLowerCase();

    let country = null;
    
    for (const c of COUNTRIES) {
      if (c.keys.some(function(key) { return originalName.includes(key); })) {
        country = c;
        break;
      }
    }
    
    if (!country) {
      const hostMatch = baseUri.match(/@([^:/]+)/);
      if (hostMatch) {
        const host = hostMatch[1].toLowerCase();
        for (const c of COUNTRIES) {
          if (c.keys.some(function(key) { return host.includes(key); })) {
            country = c;
            break;
          }
        }
      }
    }

    let displayName;
    let flag;
    let counterKey;
    
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
    const newName = flag + " " + displayName + " | БС" + superscript;
    
    return baseUri + "#" + encodeURIComponent(newName);
  });
}

// ==========================================
// ФУНКЦИИ ОБНОВЛЕНИЯ
// ==========================================

async function manualUpdate(cfg, chatId) {
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Эта команда доступна только администратору.");
  }

  await sendMessage(cfg.telegramToken, chatId, "⏳ <b>Обновляю основной конфиг...</b>\n\nСкачиваю и декодирую 4 источника...");

  try {
    const result = await fetchAndMergeSources(AUTO_UPDATE_CONFIG.sources);
    const uniqueUris = result.uris;
    const stats = result.stats;
    
    if (uniqueUris.length === 0) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось получить серверы из источников.");
    }

    let finalUris;
    if (AUTO_UPDATE_CONFIG.doRename) {
      finalUris = applyRename(uniqueUris);
    } else {
      finalUris = uniqueUris;
    }
    
    const profileMetadata = {
      title: AUTO_UPDATE_CONFIG.title,
      interval: AUTO_UPDATE_CONFIG.interval,
      webpage: AUTO_UPDATE_CONFIG.webpage,
      announce: AUTO_UPDATE_CONFIG.announce,
      userinfo: AUTO_UPDATE_CONFIG.userinfo
    };
    
    const content = buildFile(profileMetadata, finalUris);
    const saveResult = await createOrUpdateFile(cfg, AUTO_UPDATE_CONFIG.targetFilename, content, "Manual update: " + finalUris.length + " nodes");

    if (saveResult.content || saveResult.sha) {
      const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + AUTO_UPDATE_CONFIG.targetFilename;
      
      let statsText = "<b>📊 Статистика по источникам:</b>\n";
      for (const url in stats) {
        const count = stats[url];
        const shortUrl = url.length > 40 ? url.substring(0, 40) + "..." : url;
        statsText = statsText + "• " + shortUrl + "\n  ↳ <code>" + count + "</code> серверов\n";
      }
      
      const message = "✅ <b>Основной конфиг обновлен!</b>\n\n📡 Всего уникальных серверов: <code>" + finalUris.length + "</code>\n\n" + statsText + "\n📁 Файл: <code>" + AUTO_UPDATE_CONFIG.targetFilename + "</code>\n🔗 <a href=\"" + rawUrl + "\">Открыть</a>";
      const keyboard = {
        inline_keyboard: [
          [{ text: "🔄 Обновить ещё раз", callback_data: "manual_update" }]
        ]
      };
      
      await sendMessage(cfg.telegramToken, chatId, message, keyboard);
    } else {
      await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка сохранения в GitHub.");
    }
  } catch (e) {
    await sendMessage(cfg.telegramToken, chatId, "💥 Ошибка: " + e.message);
  }
}

async function secondaryManualUpdate(cfg, chatId) {
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Эта команда доступна только администратору.");
  }

  await sendMessage(cfg.telegramToken, chatId, "⏳ <b>Обновляю второй конфиг (Okeania)...</b>");

  try {
    // Здесь decodeSubscription вызывается напрямую, без проверок команд, поэтому обновление сработает
    const result = await decodeSubscription(SECONDARY_CONFIG.targetUrl);
    
    if (!result.ok || !result.uris || result.uris.length === 0) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось получить серверы: " + (result.error || "Неизвестная ошибка"));
    }

    let finalUris;
    if (SECONDARY_CONFIG.doRename) {
      finalUris = applyRename(result.uris);
    } else {
      finalUris = result.uris;
    }
    
    const profileMetadata = {
      title: SECONDARY_CONFIG.title,
      interval: SECONDARY_CONFIG.interval,
      webpage: SECONDARY_CONFIG.webpage,
      announce: SECONDARY_CONFIG.announce,
      userinfo: SECONDARY_CONFIG.userinfo
    };
    
    const content = buildFile(profileMetadata, finalUris);
    const saveResult = await createOrUpdateFile(cfg, SECONDARY_CONFIG.targetFilename, content, "Secondary Manual update: " + finalUris.length + " nodes");

    if (saveResult.content || saveResult.sha) {
      const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + SECONDARY_CONFIG.targetFilename;
      const message = "✅ <b>Второй конфиг (Okeania) обновлен!</b>\n\n📡 Серверов: <code>" + finalUris.length + "</code>\n📁 Файл: <code>" + SECONDARY_CONFIG.targetFilename + "</code>\n🔗 <a href=\"" + rawUrl + "\">Открыть</a>";
      const keyboard = {
        inline_keyboard: [
          [{ text: "🔄 Обновить ещё раз", callback_data: "secondary_manual_update" }]
        ]
      };
      
      await sendMessage(cfg.telegramToken, chatId, message, keyboard);
    } else {
      await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка сохранения в GitHub.");
    }
  } catch (e) {
    await sendMessage(cfg.telegramToken, chatId, "💥 Ошибка: " + e.message);
  }
}

export async function cmdTestLoad(cfg, chatId, url) {
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Эта команда доступна только администратору.");
  }
  if (!url || !url.startsWith("http")) {
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/testload https://example.com/sub</code>");
  }

  await sendMessage(cfg.telegramToken, chatId, "⏳ <b>Запуск стресс-теста...</b>\n\nОтправляю 100 случайных запросов с разными User-Agent.\nЭто займет около 15-20 секунд...");

  const testCount = 100;
  const uasToTest = getRandomItems(TARGET_USER_AGENTS, testCount);
  
  let successCount = 0;
  let stubCount = 0;
  let errorCount = 0;
  const successfulUAs = [];

  const testOne = async function(ua) {
    try {
      const res = await fetch(url, { method: "GET", headers: { "User-Agent": ua, "Accept": "*/*" } });
      if (!res.ok) {
        errorCount++;
        return;
      }
      const text = await res.text();
      if (isStub(text)) {
        stubCount++;
      } else {
        successCount++;
        successfulUAs.push(ua);
      }
    } catch (e) {
      errorCount++;
    }
  };

  await Promise.all(uasToTest.map(function(ua) { return testOne(ua); }));

  const successRate = ((successCount / testCount) * 100).toFixed(1);
  const stubRate = ((stubCount / testCount) * 100).toFixed(1);
  const errorRate = ((errorCount / testCount) * 100).toFixed(1);

  let uaList = "";
  const displayLimit = Math.min(successfulUAs.length, 10);
  for (let i = 0; i < displayLimit; i++) {
    uaList = uaList + (i + 1) + ". <code>" + escapeHtml(successfulUAs[i].substring(0, 60)) + "...</code>\n";
  }
  
  let moreCount = "";
  if (successfulUAs.length > 10) {
    moreCount = "\n<i>...и ещё " + (successfulUAs.length - 10) + " успешных UA</i>";
  }

  let conclusion;
  if (successCount > 50) {
    conclusion = "Сервер плохо защищён, большинство UA проходят!";
  } else if (successCount > 20) {
    conclusion = "Сервер частично блокирует ботов.";
  } else {
    conclusion = "Сервер хорошо защищён, мало UA проходят.";
  }

  const report = "✅ <b>Тестирование завершено!</b>\n\n" +
    "🔗 <b>URL:</b> <code>" + escapeHtml(url.substring(0, 50)) + "...</code>\n" +
    "📊 <b>Всего запросов:</b> <code>" + testCount + "</code>\n\n" +
    "✅ <b>Успешно:</b> <code>" + successCount + "</code> (" + successRate + "%)\n" +
    "⚠️ <b>Заглушка:</b> <code>" + stubCount + "</code> (" + stubRate + "%)\n" +
    "❌ <b>Ошибка сети:</b> <code>" + errorCount + "</code> (" + errorRate + "%)\n\n" +
    "🏆 <b>Топ успешных User-Agent'ов:</b>\n" + uaList + moreCount + "\n\n" +
    "💡 <b>Вывод:</b> " + conclusion;

  await sendMessage(cfg.telegramToken, chatId, report);
}

async function handleStepAnswer(cfg, chatId, text, state) {
  const step = state.step;
  const val = text.trim();
  
  if (val.toLowerCase() === "none") {
    state[step] = null;
  } else {
    state[step] = val;
  }
  
  const idx = STEPS.indexOf(step);
  if (idx < STEPS.length - 1) {
    state.step = STEPS[idx + 1];
    await setState(cfg, chatId, state);
    await sendMessage(cfg.telegramToken, chatId, STEP_MSG[state.step]);
  } else {
    await finalizeSubscription(cfg, chatId, state, []);
  }
}

async function finalizeSubscription(cfg, chatId, state, uris) {
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
        [{ text: "🗑 Удалить", callback_data: "delete" }]
      ]
    };
    
    const message = "✅ <b>Подписка создана!</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📡 <b>Серверов:</b> <code>" + uris.length + "</code>\n🔗 <b>Raw ссылка:</b>\n<code>" + rawUrl + "</code>\n━━━━━━━━━━━━━━━━━━━━";
    await sendMessage(cfg.telegramToken, chatId, message, kb);
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
      [{ text: "🔄 Обновить Okeania", callback_data: "secondary_manual_update" }],
      [{ text: "🧪 Тест нагрузки", callback_data: "testload_prompt" }],
      [{ text: "ℹ️ Помощь", callback_data: "help" }]
    ]
  };
  
  const message = "🌊 <b>OceaniaVPN Bot</b>\n\n👋 <b>Привет!</b>\n\n✨ <b>/create</b> — создать подписку\n🔍 <b>/decode</b> — расшифровка\n➕ <b>/add</b> — добавить сервер\n📤 <b>/export</b> — raw ссылка\n🗑 <b>/delete</b> — удалить\n🔄 <b>/update</b> — обновить whitelist (админ)\n🔄 <b>/updateokeania</b> — обновить Okeania (админ)\n🧪 <b>/testload</b> — стресс-тест (админ)";
  await sendMessage(cfg.telegramToken, chatId, message, kb);
}

export async function cmdHelp(cfg, chatId) {
  const message = "ℹ️ <b>Помощь</b>\n/start — меню\n/create — создать\n/decode <url> — расшифровать\n/my — моя подписка\n/export — raw ссылка\n/add <url> — добавить\n/delete — удалить\n/update — обновить whitelist (админ)\n/updateokeania — обновить Okeania (админ)\n/testload <url> — стресс-тест (админ)\n/cancel — отмена";
  await sendMessage(cfg.telegramToken, chatId, message);
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

export async function cmdUpdateOkeania(cfg, chatId) {
  await secondaryManualUpdate(cfg, chatId);
}

export async function cmdDecode(cfg, chatId, url) {
  if (!url || !url.startsWith("http")) {
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/decode https://example.com/sub</code>");
  }
  
  // 🔥 ЗАЩИТА: Запрещаем ручное декодирование внутренней ссылки обновления
  if (url.includes("okeaniavpn.dimastekolnikov1.workers.dev")) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ <b>Этот домен запрещен для ручного декодирования.</b>\nДля его использования предназначена только функция авто-обновления.");
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
    const filename = "decoded_" + chatId + "_" + Date.now().toString(36) + ".txt";
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
    
    const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + filename;
    const kb = {
      inline_keyboard: [
        [{ text: "📋 Открыть", url: rawUrl }]
      ]
    };
    const successMsg = "✅ <b>Успешно!</b>\n\n📡 Серверов: <code>" + uris.length + "</code>\n🔗 <code>" + rawUrl + "</code>";
    
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
  const content = await getFileContent(cfg, "user_" + chatId + ".txt");
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Подписки нет. Используй /create");
  }
  
  const lines = content.split("\n");
  const headers = lines.filter(function(l) { return l.startsWith("#"); });
  const links = lines.filter(function(l) { return l.trim() && !l.startsWith("#"); });
  
  const msg = "📋 <b>Твоя подписка</b>\n\n<b>Заголовки:</b>\n<pre>" + escapeHtml(headers.join("\n")) + "</pre>\n<b>Серверов:</b> <code>" + links.length + "</code>";
  const kb = {
    inline_keyboard: [
      [{ text: "📤 Экспорт", callback_data: "export" }],
      [{ text: "🗑 Удалить", callback_data: "delete" }]
    ]
  };
  
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

export async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, "user_" + chatId + ".txt");
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
  }
  
  const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/user_" + chatId + ".txt";
  const kb = {
    inline_keyboard: [
      [{ text: "🔗 Открыть", url: rawUrl }]
    ]
  };
  
  await sendMessage(cfg.telegramToken, chatId, "📤 <b>Экспорт</b>\n\n🔗 <code>" + rawUrl + "</code>", kb);
}

export async function cmdAdd(cfg, chatId, url) {
  if (!url) {
    return sendMessage(cfg.telegramToken, chatId, "❌ <b>Используй:</b>\n<code>/add vless://...</code>");
  }
  
  const userFile = "user_" + chatId + ".txt";
  const existing = await getFileContent(cfg, userFile);
  if (!existing) {
    return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
  }
  
  const lines = existing.split("\n");
  const headers = lines.filter(function(l) { return l.startsWith("#") || l.trim() === ""; });
  const links = lines.filter(function(l) { return !l.startsWith("#") && l.trim() !== ""; });
  
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) {
    // 🔥 ЗАЩИТА: Запрещаем добавление внутренней ссылки обновления вручную
    if (url.includes("okeaniavpn.dimastekolnikov1.workers.dev")) {
      return sendMessage(cfg.telegramToken, chatId, "⛔️ <b>Этот домен запрещен для добавления вручную.</b>");
    }
    
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
    await sendMessage(cfg.telegramToken, chatId, "✅ Добавлено: <code>" + toAdd.length + "</code>. Всего: <code>" + links.length + "</code>");
  } else {
    await sendMessage(cfg.telegramToken, chatId, "❌ Ошибка");
  }
}

export async function cmdDelete(cfg, chatId) {
  const res = await deleteFile(cfg, "user_" + chatId + ".txt", "Delete");
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
  
  let msg = "👥 <b>Пользователей:</b> <code>" + users.length + "</code>\n\n";
  for (const f of users.slice(0, 50)) {
    msg = msg + "🔹 <code>" + f.replace("user_", "").replace(".txt", "") + "</code>\n";
  }
  
  await sendMessage(cfg.telegramToken, chatId, msg);
}

export async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав");
  }
  
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId, "📊 <b>Статистика</b>\n\n👥 Пользователей: <code>" + users.length + "</code>");
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
  else if (cb.data === "secondary_manual_update") {
    if (userId !== cfg.adminId) {
      await sendMessage(cfg.telegramToken, chatId, "⛔️ Эта кнопка только для администратора.");
    } else {
      await secondaryManualUpdate(cfg, chatId);
    }
  }
  else if (cb.data === "testload_prompt") {
    if (userId !== cfg.adminId) {
      await sendMessage(cfg.telegramToken, chatId, "⛔️ Эта кнопка только для администратора.");
    } else {
      await sendMessage(cfg.telegramToken, chatId, "🧪 <b>Стресс-тест</b>\n\nОтправь мне URL подписки для тестирования, или используй:\n<code>/testload https://example.com/sub</code>");
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
  if (cmd === "/updateokeania") return cmdUpdateOkeania(cfg, chatId);
  if (cmd === "/testload") return cmdTestLoad(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
        }
