// === КОНФИГУРАЦИЯ ===
function getConfig(env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    adminId: parseInt(env.ADMIN_ID || "0"),
    repoOwner: env.REPO_OWNER || "OceaniaVPN",
    repoName: env.REPO_NAME || "OceaniaVPN",
    configsFolder: env.CONFIGS_FOLDER || "configs",
    branch: env.BRANCH || "main",
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

async function sendMessage(token, chatId, text) {
  return tgRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function sendDocument(token, chatId, content, filename, caption = "") {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
  if (caption) form.append("caption", caption);
  return fetch(url, { method: "POST", body: form }).then((r) => r.json());
}

// === GITHUB API ===
async function ghRequest(cfg, method, endpoint, body = null) {
  const url = `https://api.github.com/repos/${cfg.repoOwner}/${cfg.repoName}${endpoint}`;
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
  const data = await ghRequest(
    cfg,
    "GET",
    `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`
  );
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
    message,
    sha,
    branch: cfg.branch,
  });
}

async function getFileContent(cfg, filename) {
  const data = await ghRequest(
    cfg,
    "GET",
    `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`
  );
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

// === ОБРАБОТКА СООБЩЕНИЙ ===
async function handleUpdate(update, cfg) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  if (!text.startsWith("/")) return;

  const parts = text.split(" ");
  const cmd = parts[0].split("@")[0].toLowerCase();
  const userFile = `user_${chatId}.conf`;

  // /start
  if (cmd === "/start") {
    await sendMessage(
      cfg.telegramToken,
      chatId,
      "👋 *Добро пожаловать в OceaniaVPN!*\n\n" +
        "Создай свою VPN подписку и используй её в любом приложении.\n\n" +
        "📱 *Команды:*\n" +
        "/create `<ссылка>` — создать подписку\n" +
        "/my — показать мою подписку\n" +
        "/export — экспортировать файл\n" +
        "/delete — удалить мою подписку\n\n" +
        "*Пример:*\n`/create vless://uuid@server:port?type=ws`"
    );
  }

  // /create - создать подписку
  else if (cmd === "/create") {
    if (parts.length < 2) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        "❌ Укажи ссылку после команды.\n\n*Пример:*\n`/create vless://uuid@server:port?type=ws`"
      );
    }
    
    const content = parts.slice(1).join(" ");
    
    // Проверка что это похоже на VPN ссылку
    if (!content.includes("://")) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        "❌ Это не похоже на VPN ссылку. Ссылка должна начинаться с `vless://`, `vmess://`, `trojan://` и т.д."
      );
    }
    
    const res = await createOrUpdateFile(cfg, userFile, content, `Create subscription for user ${chatId}`);
    
    if (res.content || res.sha) {
      await sendMessage(
        cfg.telegramToken,
        chatId,
        `✅ *Подписка создана!*\n\nИспользуй /my чтобы увидеть её или /export чтобы скачать файл.`
      );
    } else {
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
    }
  }

  // /my - показать мою подписку
  else if (cmd === "/my") {
    const content = await getFileContent(cfg, userFile);
    
    if (!content) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        "📭 У тебя ещё нет подписки.\n\nСоздай её командой:\n`/create vless://...`"
      );
    }
    
    await sendMessage(
      cfg.telegramToken,
      chatId,
      `🔗 *Твоя подписка:*\n\n\`${content}\`\n\n💡 Используй /export чтобы скачать файл для импорта в приложение.`
    );
  }

  // /export - экспортировать как файл
  else if (cmd === "/export") {
    const content = await getFileContent(cfg, userFile);
    
    if (!content) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        "📭 У тебя ещё нет подписки.\n\nСоздай её командой:\n`/create vless://...`"
      );
    }
    
    await sendDocument(
      cfg.telegramToken,
      chatId,
      content,
      `oceaniavpn_${chatId}.conf`,
      "🔗 Твоя VPN подписка OceaniaVPN"
    );
  }

  // /delete - удалить мою подписку
  else if (cmd === "/delete") {
    const res = await deleteFile(cfg, userFile, `Delete subscription for user ${chatId}`);
    
    if (res.commit) {
      await sendMessage(cfg.telegramToken, chatId, "🗑 Твоя подписка удалена.");
    } else {
      await sendMessage(cfg.telegramToken, chatId, "📭 У тебя нет подписки.");
    }
  }

  // /admin - админ команды (только для админа)
  else if (cmd === "/admin") {
    if (userId !== cfg.adminId) {
      return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    }
    
    await sendMessage(
      cfg.telegramToken,
      chatId,
      "🛠 *Админ команды:*\n\n" +
        "/users — список всех пользователей\n" +
        "/stats — статистика"
    );
  }

  // /users - список всех пользователей (админ)
  else if (cmd === "/users") {
    if (userId !== cfg.adminId) {
      return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    }
    
    const users = await listAllUsers(cfg);
    
    if (users.length === 0) {
      return sendMessage(cfg.telegramToken, chatId, "📭 Пользователей пока нет.");
    }
    
    let response = `👥 *Всего пользователей: ${users.length}*\n\n`;
    for (const file of users) {
      const uid = file.replace("user_", "").replace(".conf", "");
      response += `🔹 ID: \`${uid}\`\n`;
    }
    
    await sendMessage(cfg.telegramToken, chatId, response);
  }

  // /stats - статистика (админ)
  else if (cmd === "/stats") {
    if (userId !== cfg.adminId) {
      return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    }
    
    const users = await listAllUsers(cfg);
    
    await sendMessage(
      cfg.telegramToken,
      chatId,
      `📊 *Статистика OceaniaVPN*\n\n` +
        `👥 Пользователей: ${users.length}\n` +
        `📁 Файлов в configs/: ${users.length}`
    );
  }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК ===
export default {
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);

    // Служебные GET эндпоинты
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response(
          "<h1>🚀 OceaniaVPN Bot Active</h1><p>Бот работает на Cloudflare Workers.</p>",
          { headers: { "Content-Type": "text/html" } }
        );
      }
      if (url.pathname === "/set-webhook") {
        const workerUrl = `${url.protocol}//${url.host}`;
        const res = await tgRequest(cfg.telegramToken, "setWebhook", { url: workerUrl });
        return new Response(JSON.stringify(res, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // Обработка webhook от Telegram (POST)
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
