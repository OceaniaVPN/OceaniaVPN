// === КОНФИГУРАЦИЯ ===
function getConfig(env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    adminId: parseInt(env.ADMIN_ID || "0"),
    configRepoOwner: env.CONFIG_REPO_OWNER || "OceaniaVPN",
    configRepoName: env.CONFIG_REPO_NAME || "StekloVPN",
    configsFolder: env.CONFIGS_FOLDER || "configs",
    branch: env.BRANCH || "main",
    kv: env.BOT_STATE,
  };
}

// === TELEGRAM API ===
async function tgRequest(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgRequest(token, "sendMessage", body);
}

// === GITHUB API ===
async function ghRequest(cfg, method, endpoint, body = null) {
  const url = `https://api.github.com/repos/${cfg.configRepoOwner}/${cfg.configRepoName}${endpoint}`;
  const headers = {
    Authorization: `token ${cfg.githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "OceaniaVPN-Bot",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
    return fetch(url, { method, headers, body: JSON.stringify(body) }).then((r) => r.json());
  }
  return fetch(url, { method, headers }).then((r) => r.json());
}

async function getFileSha(cfg, filename) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`);
  return data?.sha || null;
}

async function createOrUpdateFile(cfg, filename, content, message) {
  const sha = await getFileSha(cfg, filename);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  return ghRequest(cfg, "PUT", `/contents/${cfg.configsFolder}/${filename}`, body);
}

async function deleteFile(cfg, filename, message) {
  const sha = await getFileSha(cfg, filename);
  if (!sha) return { message: "File not found" };
  return ghRequest(cfg, "DELETE", `/contents/${cfg.configsFolder}/${filename}`, {
    message, sha, branch: cfg.branch,
  });
}

async function getFileContent(cfg, filename) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`);
  if (!data?.content) return null;
  try {
    return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
  } catch {
    return null;
  }
}

async function listAllUsers(cfg) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}?ref=${cfg.branch}`);
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === "file" && f.name.startsWith("user_")).map((f) => f.name);
}

// === FSM (FINITE STATE MACHINE) ===
const STEPS = ["title", "announce", "webpage", "interval", "links"];

async function getState(cfg, chatId) {
  const data = await cfg.kv.get(`state_${chatId}`, "json");
  return data || null;
}

async function setState(cfg, chatId, state) {
  await cfg.kv.put(`state_${chatId}`, JSON.stringify(state), { expirationTtl: 3600 });
}

async function clearState(cfg, chatId) {
  await cfg.kv.delete(`state_${chatId}`);
}

// === ПОСТРОЕНИЕ ФАЙЛА ПОДПИСКИ ===
function buildSubscriptionFile(state) {
  const lines = [];
  
  if (state.title) lines.push(`#profile-title: ${state.title}`);
  if (state.interval) lines.push(`#profile-update-interval: ${state.interval}`);
  lines.push(`#subscription-userinfo: upload=0; download=0; total=536870912000; expire=0`);
  if (state.webpage) lines.push(`#profile-web-page-url: ${state.webpage}`);
  if (state.announce) lines.push(`#announce: ${state.announce}`);
  
  lines.push(""); // пустая строка перед ссылками
  
  if (state.links && state.links.length > 0) {
    lines.push(...state.links);
  }
  
  return lines.join("\n");
}

// === СООБЩЕНИЯ ДЛЯ КАЖДОГО ШАГА ===
const STEP_MESSAGES = {
  title: "📝 **Шаг 1/4: Имя подписки**\n\nВведи название профиля (будет отображаться в приложении).\n\n*Пример:* `🟦Steklo_VPN whitelist 🦆`\n\nИли отправь `none` чтобы пропустить.",
  announce: "📢 **Шаг 2/4: Описание**\n\nВведи текст объявления (показывается пользователям).\n\n*Пример:* `✨ Стекло впн бесплатно, поддержите канал @free_vpn123456`\n\nИли отправь `none` чтобы пропустить.",
  webpage: "🌐 **Шаг 3/4: Хелп-ссылка**\n\nВведи ссылку на поддержку или главную страницу.\n\n*Пример:* `https://t.me/free_vpn123456`\n\nИли отправь `none` чтобы пропустить.",
  interval: "⏰ **Шаг 4/4: Интервал обновления**\n\nЧерез сколько часов приложение должно обновлять подписку?\n\n*Пример:* `4` (каждые 4 часа)\n\nИли отправь `none` чтобы пропустить.",
  links: "🔗 **Последний шаг: VPN ссылки**\n\nОтправь одну или несколько ссылок (каждую с новой строки).\n\n*Пример:*\n```\nvless://uuid@server:port?type=ws#USA\nvless://uuid@server2:port?type=ws#Germany\n```\n\nМожешь добавлять ссылки командой `/add <ссылка>` после создания.",
};

// === ОБРАБОТКА ОТВЕТА НА ШАГ ===
async function handleStepAnswer(cfg, chatId, text, state) {
  const currentStep = state.step;
  const value = text.trim();
  
  // Сохраняем значение (none = пропускаем)
  if (value.toLowerCase() === "none" || value === "пропустить") {
    state[currentStep] = null;
  } else {
    state[currentStep] = value;
  }
  
  // Переходим к следующему шагу
  const currentIndex = STEPS.indexOf(currentStep);
  if (currentIndex < STEPS.length - 1) {
    state.step = STEPS[currentIndex + 1];
    await setState(cfg, chatId, state);
    await sendMessage(cfg.telegramToken, chatId, STEP_MESSAGES[state.step]);
  } else {
    // Последний шаг — создаём подписку
    await finalizeSubscription(cfg, chatId, state);
  }
}

async function finalizeSubscription(cfg, chatId, state) {
  // Если ссылок нет — создаём пустую подписку
  if (!state.links || state.links.length === 0) {
    state.links = [];
  }
  
  const content = buildSubscriptionFile(state);
  const userFile = `user_${chatId}.txt`;
  
  const res = await createOrUpdateFile(cfg, userFile, content, `Create subscription for user ${chatId}`);
  
  await clearState(cfg, chatId);
  
  if (res.content || res.sha) {
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
    
    await sendMessage(
      cfg.telegramToken,
      chatId,
      `✅ *Подписка создана!*\n\n` +
      `📤 *Ссылка для приложения:*\n\`${rawUrl}\`\n\n` +
      `💡 Вставь в:\n` +
      `• v2rayNG → Subscription → Add\n` +
      `• Hiddify → Add Profile\n` +
      `• Shadowrocket → Add → Subscribe\n\n` +
      `Используй /my чтобы увидеть или /add чтобы добавить сервер.`
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
  }
}

// === ОБРАБОТКА СООБЩЕНИЙ ===
async function handleUpdate(update, cfg) {
  if (!update.message) return;
  
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";
  
  // Проверяем есть ли активный процесс создания
  const state = await getState(cfg, chatId);
  
  if (state && state.step && !text.startsWith("/")) {
    // Если последний шаг — ссылки (могут быть многострочными)
    if (state.step === "links") {
      state.links = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      await finalizeSubscription(cfg, chatId, state);
      return;
    }
    
    // Иначе обрабатываем как ответ на текущий шаг
    await handleStepAnswer(cfg, chatId, text, state);
    return;
  }
  
  if (!text.startsWith("/")) return;
  
  const parts = text.split(" ");
  const cmd = parts[0].split("@")[0].toLowerCase();
  const userFile = `user_${chatId}.txt`;
  
  // /start
  if (cmd === "/start") {
    await clearState(cfg, chatId);
    await sendMessage(
      cfg.telegramToken,
      chatId,
      "👋 *Добро пожаловать в OceaniaVPN!*\n\n" +
      "Создай свою VPN подписку и используй её в любом приложении.\n\n" +
      "📱 *Команды:*\n" +
      "/create — создать подписку (пошагово)\n" +
      "/add `<ссылка>` — добавить сервер\n" +
      "/my — показать мою подписку\n" +
      "/export — получить raw ссылку\n" +
      "/delete — удалить мою подписку\n" +
      "/cancel — отменить создание"
    );
  }
  
  // /create - начать пошаговое создание
  else if (cmd === "/create") {
    const newState = { step: "title" };
    await setState(cfg, chatId, newState);
    await sendMessage(cfg.telegramToken, chatId, STEP_MESSAGES.title);
  }
  
  // /cancel - отменить создание
  else if (cmd === "/cancel") {
    if (state) {
      await clearState(cfg, chatId);
      await sendMessage(cfg.telegramToken, chatId, "❌ Создание подписки отменено.");
    } else {
      await sendMessage(cfg.telegramToken, chatId, "ℹ️ У тебя нет активного процесса создания.");
    }
  }
  
  // /add - добавить сервер
  else if (cmd === "/add") {
    if (parts.length < 2) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Укажи ссылку.\n*Пример:* `/add vless://...#USA`");
    }
    
    const newLine = parts.slice(1).join(" ");
    
    if (!newLine.includes("://")) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Это не похоже на VPN ссылку.");
    }
    
    const existing = await getFileContent(cfg, userFile);
    
    if (!existing) {
      return sendMessage(cfg.telegramToken, chatId, "📭 Сначала создай подписку: `/create`");
    }
    
    // Разделяем заголовки и ссылки
    const lines = existing.split("\n");
    const headerLines = [];
    const linkLines = [];
    
    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") {
        headerLines.push(line);
      } else {
        linkLines.push(line);
      }
    }
    
    // Добавляем новую ссылку
    linkLines.push(newLine.trim());
    
    // Собираем обратно
    const updatedContent = headerLines.join("\n") + "\n" + linkLines.join("\n");
    
    const res = await createOrUpdateFile(cfg, userFile, updatedContent, `Add node for user ${chatId}`);
    
    if (res.content || res.sha) {
      await sendMessage(cfg.telegramToken, chatId, `✅ Сервер добавлен! Всего серверов: ${linkLines.length}`);
    } else {
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
    }
  }
  
  // /my - показать подписку
  else if (cmd === "/my") {
    const content = await getFileContent(cfg, userFile);
    
    if (!content) {
      return sendMessage(cfg.telegramToken, chatId, "📭 У тебя нет подписки.\n\nСоздай: `/create`");
    }
    
    await sendMessage(cfg.telegramToken, chatId, `🔗 *Твоя подписка:*\n\n\`\`\`\n${content}\n\`\`\``);
  }
  
  // /export - raw ссылка
  else if (cmd === "/export") {
    const content = await getFileContent(cfg, userFile);
    
    if (!content) {
      return sendMessage(cfg.telegramToken, chatId, "📭 Сначала создай подписку: `/create`");
    }
    
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
    
    await sendMessage(
      cfg.telegramToken,
      chatId,
      `📤 *Твоя ссылка для подписки:*\n\n\`${rawUrl}\`\n\n` +
      `💡 Вставь в приложение:\n` +
      `• v2rayNG → Subscription → Add\n` +
      `• Hiddify → Add Profile\n` +
      `• Shadowrocket → Add → Subscribe`
    );
  }
  
  // /delete
  else if (cmd === "/delete") {
    const res = await deleteFile(cfg, userFile, `Delete subscription for user ${chatId}`);
    
    if (res.commit) {
      await sendMessage(cfg.telegramToken, chatId, "🗑 Подписка удалена.");
    } else {
      await sendMessage(cfg.telegramToken, chatId, "📭 У тебя нет подписки.");
    }
  }
  
  // === АДМИН КОМАНДЫ ===
  else if (cmd === "/admin") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    await sendMessage(
      cfg.telegramToken,
      chatId,
      "🛠 *Админ команды:*\n\n/users — список пользователей\n/stats — статистика"
    );
  }
  
  else if (cmd === "/users") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    const users = await listAllUsers(cfg);
    if (users.length === 0) return sendMessage(cfg.telegramToken, chatId, "📭 Пользователей нет.");
    let response = `👥 *Всего: ${users.length}*\n\n`;
    for (const file of users) {
      const uid = file.replace("user_", "").replace(".txt", "");
      response += `🔹 ID: \`${uid}\`\n`;
    }
    await sendMessage(cfg.telegramToken, chatId, response);
  }
  
  else if (cmd === "/stats") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    const users = await listAllUsers(cfg);
    await sendMessage(cfg.telegramToken, chatId, `📊 *Статистика*\n\n👥 Пользователей: ${users.length}`);
  }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК ===
export default {
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response("<h1>🚀 OceaniaVPN Bot Active</h1>", { headers: { "Content-Type": "text/html" } });
      }
      if (url.pathname === "/set-webhook") {
        const workerUrl = `${url.protocol}//${url.host}`;
        const res = await tgRequest(cfg.telegramToken, "setWebhook", { url: workerUrl });
        return new Response(JSON.stringify(res, null, 2), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }
    
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, cfg);
        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }
    
    return new Response("Method not allowed", { status: 405 });
  },
};
