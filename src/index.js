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

async function listFiles(cfg) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}?ref=${cfg.branch}`);
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === "file").map((f) => f.name);
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

// === ОБРАБОТКА СООБЩЕНИЙ ===
async function handleUpdate(update, cfg, workerUrl) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  if (!text.startsWith("/")) return;

  const parts = text.split(" ");
  const cmd = parts[0].split("@")[0].toLowerCase();

  // /start
  if (cmd === "/start") {
    await sendMessage(
      cfg.telegramToken,
      chatId,
      "👋 *OceaniaVPN Bot*\n\n" +
        "📱 *Команды:*\n" +
        "/list — список конфигов\n" +
        "/get <имя> — скачать конфиг\n\n" +
        "🛠 *Для админа:*\n" +
        "/add <имя> <ссылка> — добавить\n" +
        "/delete <имя> — удалить"
    );
  }

  // /add
  else if (cmd === "/add") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    if (parts.length < 3) {
      return sendMessage(
        cfg.telegramToken,
        chatId,
        "❌ Формат: `/add имя ссылка`\n*Пример:* `/add usa.conf vless://...`"
      );
    }
    const filename = parts[1];
    const content = parts.slice(2).join(" ");
    const res = await createOrUpdateFile(cfg, filename, content, `Add VPN config: ${filename}`);
    if (res.content || res.sha) {
      await sendMessage(cfg.telegramToken, chatId, `✅ Файл \`${filename}\` сохранён в \`${cfg.configsFolder}/\``);
    } else {
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
    }
  }

  // /delete
  else if (cmd === "/delete") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    if (parts.length < 2) return sendMessage(cfg.telegramToken, chatId, "❌ Укажи имя файла.");
    const filename = parts[1];
    const res = await deleteFile(cfg, filename, `Delete: ${filename}`);
    if (res.commit) {
      await sendMessage(cfg.telegramToken, chatId, `🗑 Файл \`${filename}\` удалён.`);
    } else {
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
    }
  }

  // /list
  else if (cmd === "/list") {
    const files = await listFiles(cfg);
    if (files.length === 0) return sendMessage(cfg.telegramToken, chatId, "📭 Конфигов пока нет.");
    let response = `📂 *Конфиги в \`${cfg.configsFolder}/\`:*\n\n`;
    for (const name of files) response += `🔹 \`${name}\`\n`;
    response += "\n💡 Чтобы скачать: `/get имя`";
    await sendMessage(cfg.telegramToken, chatId, response);
  }

  // /get
  else if (cmd === "/get") {
    if (parts.length < 2) return sendMessage(cfg.telegramToken, chatId, "❌ Укажи имя файла.");
    const filename = parts[1];
    const content = await getFileContent(cfg, filename);
    if (!content) return sendMessage(cfg.telegramToken, chatId, `❌ Файл \`${filename}\` не найден.`);
    if (content.length > 3000) {
      await sendDocument(cfg.telegramToken, chatId, content, filename, `🔗 Конфиг ${filename}`);
    } else {
      await sendMessage(cfg.telegramToken, chatId, `🔗 *${filename}:*\n\n\`${content}\``);
    }
  }

  // /setwebhook (только админ)
  else if (cmd === "/setwebhook") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав.");
    if (!workerUrl) return sendMessage(cfg.telegramToken, chatId, "❌ Не удалось определить URL воркера.");
    const res = await tgRequest(cfg.telegramToken, "setWebhook", { url: workerUrl });
    await sendMessage(cfg.telegramToken, chatId, res.ok ? `✅ Webhook установлен: ${workerUrl}` : `❌ Ошибка: ${res.description}`);
  }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК ===
export default {
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    const workerUrl = `${url.protocol}//${url.host}`;

    // Служебные GET эндпоинты
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response(
          "<h1>🚀 OceaniaVPN Bot Active</h1><p>Бот работает на Cloudflare Workers.</p>",
          { headers: { "Content-Type": "text/html" } }
        );
      }
      if (url.pathname === "/set-webhook") {
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
        await handleUpdate(update, cfg, workerUrl);
        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};
