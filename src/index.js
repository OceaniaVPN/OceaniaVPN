import yaml from "js-yaml";

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

async function sendMessage(token, chatId, text) {
  return tgRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
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

// === FSM ===
const STEPS = ["title", "announce", "webpage", "interval", "links"];

async function getState(cfg, chatId) {
  return cfg.kv.get(`state_${chatId}`, "json") || null;
}

async function setState(cfg, chatId, state) {
  await cfg.kv.put(`state_${chatId}`, JSON.stringify(state), { expirationTtl: 3600 });
}

async function clearState(cfg, chatId) {
  await cfg.kv.delete(`state_${chatId}`);
}

// === ДЕКОДЕР ПОДПИСОК ===

// Маскировка под Happ
const HAPP_USER_AGENT = "Happ/10.0.0 (Android; 13; Pixel 7) okhttp/4.12.0";
const HAPP_HEADERS = {
  "User-Agent": HAPP_USER_AGENT,
  "Accept": "*/*",
  "X-Happ-App": "Happ",
  "X-Happ-Platform": "android",
};

// Получение контента подписки с маскировкой
async function fetchSubscription(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: HAPP_HEADERS,
      redirect: "follow",
    });
    
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    const text = await response.text();
    return { ok: true, content: text, contentType: response.headers.get("content-type") || "" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Определение типа контента
function detectContentType(content, url = "") {
  // Убираем параметр hide-settings для определения
  const cleanContent = content.trim();
  
  // Проверяем crypt форматы
  if (cleanContent.startsWith("crypt5://") || cleanContent.startsWith("crypt4://")) {
    return "crypt";
  }
  
  // Это список vless/vmess/trojan ссылок
  const lines = cleanContent.split("\n").filter(l => l.trim());
  if (lines.every(l => /^[a-z]+:\/\//.test(l.trim()) || l.startsWith("#"))) {
    return "vless-list";
  }
  
  // Это base64 от vless/vmess ссылок
  try {
    const decoded = atob(cleanContent.replace(/\s/g, ""));
    if (decoded.includes("://")) return "base64-list";
  } catch {}
  
  // YAML (Clash/Mihomo)
  if (cleanContent.includes("proxies:") || cleanContent.includes("proxy-groups:") || cleanContent.toLowerCase().includes("mixed-port:")) {
    return "yaml";
  }
  
  // JSON конфиг
  try {
    JSON.parse(cleanContent);
    return "json";
  } catch {}
  
  return "unknown";
}

// Конвертация одного proxy из YAML в vless/vmess строку
function proxyToUri(proxy) {
  if (!proxy || !proxy.type) return null;
  
  const type = proxy.type.toLowerCase();
  const name = proxy.name || "Server";
  
  // VLESS
  if (type === "vless") {
    const params = new URLSearchParams();
    if (proxy.network) params.set("type", proxy.network);
    if (proxy["ws-opts"]?.path) params.set("path", proxy["ws-opts"].path);
    if (proxy["ws-opts"]?.headers?.Host) params.set("host", proxy["ws-opts"].headers.Host);
    if (proxy["grpc-opts"]?.["grpc-service-name"]) params.set("serviceName", proxy["grpc-opts"]["grpc-service-name"]);
    if (proxy.tls) params.set("security", proxy.tls ? "tls" : "none");
    if (proxy.sni) params.set("sni", proxy.sni);
    if (proxy["client-fingerprint"]) params.set("fp", proxy["client-fingerprint"]);
    if (proxy.flow) params.set("flow", proxy.flow);
    
    const query = params.toString();
    return `vless://${proxy.uuid}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${encodeURIComponent(name)}`;
  }
  
  // VMess
  if (type === "vmess") {
    const vmess = {
      v: "2",
      ps: name,
      add: proxy.server,
      port: proxy.port,
      id: proxy.uuid,
      aid: proxy.alterId || 0,
      net: proxy.network || "tcp",
      type: "none",
      host: proxy["ws-opts"]?.headers?.Host || "",
      path: proxy["ws-opts"]?.path || "",
      tls: proxy.tls ? "tls" : "",
      sni: proxy.sni || "",
    };
    return `vmess://` + btoa(JSON.stringify(vmess));
  }
  
  // Trojan
  if (type === "trojan") {
    const params = new URLSearchParams();
    if (proxy.network) params.set("type", proxy.network);
    if (proxy["ws-opts"]?.path) params.set("path", proxy["ws-opts"].path);
    if (proxy["ws-opts"]?.headers?.Host) params.set("host", proxy["ws-opts"].headers.Host);
    if (proxy.sni) params.set("sni", proxy.sni);
    params.set("security", "tls");
    
    const query = params.toString();
    return `trojan://${proxy.password}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${encodeURIComponent(name)}`;
  }
  
  // Shadowsocks
  if (type === "ss" || type === "shadowsocks") {
    const userinfo = btoa(`${proxy.cipher}:${proxy.password}`);
    return `ss://${userinfo}@${proxy.server}:${proxy.port}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// Парсинг YAML и извлечение proxies
function parseYaml(content) {
  try {
    const config = yaml.load(content);
    const proxies = config?.proxies || [];
    const uris = [];
    
    for (const proxy of proxies) {
      const uri = proxyToUri(proxy);
      if (uri) uris.push(uri);
    }
    
    // Извлекаем metadata
    const metadata = {};
    if (config?.["profile-title"]) metadata.title = config["profile-title"];
    if (config?.["profile-update-interval"]) metadata.interval = config["profile-update-interval"];
    
    return { ok: true, uris, metadata };
  } catch (err) {
    return { ok: false, error: "YAML parse error: " + err.message };
  }
}

// Парсинг base64-encoded списка
function parseBase64List(content) {
  try {
    const clean = content.replace(/\s/g, "");
    const decoded = atob(clean);
    const lines = decoded.split("\n").map(l => l.trim()).filter(l => l);
    return { ok: true, uris: lines };
  } catch (err) {
    return { ok: false, error: "Base64 decode error" };
  }
}

// Парсинг обычного списка
function parseVlessList(content) {
  const lines = content.split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && /^[a-z]+:\/\//.test(l));
  return { ok: true, uris: lines };
}

// Попытка дешифровки crypt5/crypt4 (fallback — передаём как есть)
function parseCrypt(content) {
  // Точный алгоритм дешифровки неизвестен публично
  // Возвращаем с пометкой что это зашифрованный формат
  return {
    ok: false,
    error: "crypt5/crypt4 — закрытый формат Happ/Hiddify. Требуется ключ дешифровки. Ссылка сохранена как есть.",
    raw: content,
  };
}

// Основная функция декодирования
async function decodeSubscription(url) {
  // Убираем hide-settings=1 из URL (это клиентский параметр, не влияет на сервер)
  let cleanUrl = url.split("#")[0]; // убираем фрагменты
  
  const result = await fetchSubscription(cleanUrl);
  
  if (!result.ok) {
    return { ok: false, error: `Не удалось получить подписку: ${result.error}` };
  }
  
  const contentType = detectContentType(result.content, url);
  
  switch (contentType) {
    case "vless-list":
      return parseVlessList(result.content);
      
    case "base64-list":
      return parseBase64List(result.content);
      
    case "yaml":
      return parseYaml(result.content);
      
    case "crypt":
      return parseCrypt(result.content);
      
    case "json":
      return { ok: false, error: "JSON формат не поддерживается (конвертируйте в YAML или vless)" };
      
    default:
      return { ok: false, error: `Неизвестный формат подписки. Content-Type: ${result.contentType}` };
  }
}

// === СОЗДАНИЕ ФАЙЛА ПОДПИСКИ ===
function buildSubscriptionFile(state, uris = []) {
  const lines = [];
  
  if (state.title) lines.push(`#profile-title: ${state.title}`);
  if (state.interval) lines.push(`#profile-update-interval: ${state.interval}`);
  lines.push(`#subscription-userinfo: upload=0; download=0; total=536870912000; expire=0`);
  if (state.webpage) lines.push(`#profile-web-page-url: ${state.webpage}`);
  if (state.announce) lines.push(`#announce: ${state.announce}`);
  
  lines.push("");
  if (uris.length > 0) lines.push(...uris);
  
  return lines.join("\n");
}

const STEP_MESSAGES = {
  title: "📝 **Шаг 1/4: Имя подписки**\n\nВведи название профиля.\n*Пример:* `🟦Steklo_VPN whitelist`\n\nИли `none` чтобы пропустить.",
  announce: "📢 **Шаг 2/4: Описание**\n\nВведи текст объявления.\nИли `none` чтобы пропустить.",
  webpage: "🌐 **Шаг 3/4: Хелп-ссылка**\n\nСсылка на канал/поддержку.\nИли `none` чтобы пропустить.",
  interval: "⏰ **Шаг 4/4: Интервал обновления**\n\nВ часах (например `4`).\nИли `none`.",
};

async function handleStepAnswer(cfg, chatId, text, state) {
  const currentStep = state.step;
  const value = text.trim();
  state[currentStep] = (value.toLowerCase() === "none") ? null : value;
  
  const currentIndex = STEPS.indexOf(currentStep);
  if (currentIndex < STEPS.length - 1) {
    state.step = STEPS[currentIndex + 1];
    await setState(cfg, chatId, state);
    await sendMessage(cfg.telegramToken, chatId, STEP_MESSAGES[state.step]);
  } else {
    await finalizeSubscription(cfg, chatId, state);
  }
}

async function finalizeSubscription(cfg, chatId, state, uris = []) {
  state.links = uris;
  const content = buildSubscriptionFile(state, uris);
  const userFile = `user_${chatId}.txt`;
  
  const res = await createOrUpdateFile(cfg, userFile, content, `Create subscription for user ${chatId}`);
  await clearState(cfg, chatId);
  
  if (res.content || res.sha) {
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
    await sendMessage(
      cfg.telegramToken, chatId,
      `✅ *Подписка создана!*\n\n📤 *Ссылка:*\n\`${rawUrl}\`\n\n` +
      `💡 Серверов: ${uris.length}\n\nИспользуй /add чтобы добавить ещё.`
    );
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка: ${res.message || "неизвестно"}`);
  }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК ===
async function handleUpdate(update, cfg) {
  if (!update.message) return;
  
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";
  
  const state = await getState(cfg, chatId);
  
  // Обрабатываем ответы в FSM
  if (state && state.step && !text.startsWith("/")) {
    await handleStepAnswer(cfg, chatId, text, state);
    return;
  }
  
  // Автоматическое декодирование: если сообщение — ссылка
  if (!text.startsWith("/") && text.trim().startsWith("http")) {
    const url = text.trim();
    await sendMessage(cfg.telegramToken, chatId, "🔍 *Декодирую подписку...*\nМаскируюсь под Happ 🥷", "Markdown");
    
    const result = await decodeSubscription(url);
    
    if (result.ok) {
      const userFile = `decoded_${chatId}_${Date.now()}.txt`;
      const content = buildSubscriptionFile(
        { title: `Decoded from ${new URL(url).hostname}`, interval: 4 },
        result.uris
      );
      
      const res = await createOrUpdateFile(cfg, userFile, content, `Decode subscription for user ${chatId}`);
      
      if (res.content || res.sha) {
        const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
        await sendMessage(
          cfg.telegramToken, chatId,
          `✅ *Расшифровано!*\n\n` +
          `📡 Серверов найдено: ${result.uris.length}\n\n` +
          `🔗 *Ссылка:*\n\`${rawUrl}\`\n\n` +
          `💡 Можно импортировать в v2rayNG, Hiddify, Shadowrocket`
        );
      }
    } else {
      await sendMessage(cfg.telegramToken, chatId, `⚠️ ${result.error}`);
    }
    return;
  }
  
  if (!text.startsWith("/")) return;
  
  const parts = text.split(" ");
  const cmd = parts[0].split("@")[0].toLowerCase();
  const userFile = `user_${chatId}.txt`;
  
  if (cmd === "/start") {
    await clearState(cfg, chatId);
    await sendMessage(
      cfg.telegramToken, chatId,
      "👋 *OceaniaVPN Bot*\n\n" +
      "📱 *Команды:*\n" +
      "/create — создать подписку пошагово\n" +
      "/decode <url> — расшифровать чужую подписку\n" +
      "/add <ссылка> — добавить сервер\n" +
      "/my — моя подписка\n" +
      "/export — raw ссылка\n" +
      "/delete — удалить\n" +
      "/cancel — отменить\n\n" +
      "💡 *Совет:* просто отправь мне URL подписки — я сам её расшифрую и сохраню!"
    );
  }
  
  else if (cmd === "/create") {
    const newState = { step: "title" };
    await setState(cfg, chatId, newState);
    await sendMessage(cfg.telegramToken, chatId, STEP_MESSAGES.title);
  }
  
  else if (cmd === "/decode") {
    if (parts.length < 2) {
      return sendMessage(cfg.telegramToken, chatId, "❌ Укажи URL.\n*Пример:* `/decode https://...`");
    }
    
    const url = parts[1];
    await sendMessage(cfg.telegramToken, chatId, "🔍 *Декодирую...*\nМаскируюсь под Happ 🥷", "Markdown");
    
    const result = await decodeSubscription(url);
    
    if (result.ok) {
      const userFile = `decoded_${chatId}_${Date.now()}.txt`;
      const content = buildSubscriptionFile(
        { title: `Decoded from ${new URL(url).hostname}`, interval: 4 },
        result.uris
      );
      
      const res = await createOrUpdateFile(cfg, userFile, content, `Decode for user ${chatId}`);
      
      if (res.content || res.sha) {
        const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
        await sendMessage(
          cfg.telegramToken, chatId,
          `✅ *Расшифровано!*\n\n` +
          `📡 Серверов: ${result.uris.length}\n\n` +
          `🔗 *Ссылка:*\n\`${rawUrl}\``
        );
      } else {
        await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка сохранения`);
      }
    } else {
      await sendMessage(cfg.telegramToken, chatId, `⚠️ ${result.error}`);
    }
  }
  
  else if (cmd === "/cancel") {
    if (state) {
      await clearState(cfg, chatId);
      await sendMessage(cfg.telegramToken, chatId, "❌ Создание отменено.");
    } else {
      await sendMessage(cfg.telegramToken, chatId, "ℹ️ Нет активного процесса.");
    }
  }
  
  else if (cmd === "/add") {
    if (parts.length < 2) return sendMessage(cfg.telegramToken, chatId, "❌ Укажи ссылку.");
    const newLine = parts.slice(1).join(" ");
    if (!newLine.includes("://")) return sendMessage(cfg.telegramToken, chatId, "❌ Не похоже на VPN ссылку.");
    
    const existing = await getFileContent(cfg, userFile);
    if (!existing) return sendMessage(cfg.telegramToken, chatId, "📭 Сначала /create");
    
    const lines = existing.split("\n");
    const header = [];
    const links = [];
    for (const line of lines) {
      if (line.startsWith("#") || line.trim() === "") header.push(line);
      else links.push(line);
    }
    links.push(newLine.trim());
    const updated = header.join("\n") + "\n" + links.join("\n");
    
    const res = await createOrUpdateFile(cfg, userFile, updated, `Add node for user ${chatId}`);
    if (res.content || res.sha) {
      await sendMessage(cfg.telegramToken, chatId, `✅ Добавлено! Всего: ${links.length}`);
    } else {
      await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка`);
    }
  }
  
  else if (cmd === "/my") {
    const content = await getFileContent(cfg, userFile);
    if (!content) return sendMessage(cfg.telegramToken, chatId, "📭 Нет подписки. /create");
    await sendMessage(cfg.telegramToken, chatId, `🔗 *Подписка:*\n\n\`\`\`\n${content}\n\`\`\``);
  }
  
  else if (cmd === "/export") {
    const content = await getFileContent(cfg, userFile);
    if (!content) return sendMessage(cfg.telegramToken, chatId, "📭 /create");
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${userFile}`;
    await sendMessage(cfg.telegramToken, chatId, `📤 *Ссылка:*\n\n\`${rawUrl}\``);
  }
  
  else if (cmd === "/delete") {
    const res = await deleteFile(cfg, userFile, `Delete for user ${chatId}`);
    await sendMessage(cfg.telegramToken, chatId, res.commit ? "🗑 Удалено" : "📭 Нет подписки");
  }
  
  else if (cmd === "/admin") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️");
    await sendMessage(cfg.telegramToken, chatId, "🛠 /users /stats");
  }
  
  else if (cmd === "/users") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️");
    const users = await listAllUsers(cfg);
    await sendMessage(cfg.telegramToken, chatId, `👥 Всего: ${users.length}`);
  }
  
  else if (cmd === "/stats") {
    if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, "⛔️");
    const users = await listAllUsers(cfg);
    await sendMessage(cfg.telegramToken, chatId, `📊 Пользователей: ${users.length}`);
  }
}

export default {
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response("<h1>🚀 OceaniaVPN Bot</h1>", { headers: { "Content-Type": "text/html" } });
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
