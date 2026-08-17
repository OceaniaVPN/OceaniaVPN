import yaml from "js-yaml";

// ═══════════════════════════════════════════
//  КОНФИГУРАЦИЯ
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  TELEGRAM API
// ═══════════════════════════════════════════
async function tgRequest(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

async function sendMessage(token, chatId, text, replyMarkup = null, parseMode = "HTML") {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgRequest(token, "sendMessage", body);
}

async function editMessage(token, chatId, messageId, text, replyMarkup = null) {
  return tgRequest(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
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

// ═══════════════════════════════════════════
//  GITHUB API
// ═══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  FSM (состояния пользователя)
// ═══════════════════════════════════════════
const STEPS = ["title", "announce", "webpage", "interval", "links"];

async function getState(cfg, chatId) {
  return await cfg.kv.get(`state_${chatId}`, "json");
}

async function setState(cfg, chatId, state) {
  await cfg.kv.put(`state_${chatId}`, JSON.stringify(state), { expirationTtl: 3600 });
}

async function clearState(cfg, chatId) {
  await cfg.kv.delete(`state_${chatId}`);
}

// ═══════════════════════════════════════════
//  🔥 МОЩНЫЙ ДЕКОДЕР ПОДПИСОК
// ═══════════════════════════════════════════

const HAPP_UA = "Happ/10.0.0 (Android; 13; Pixel 7) okhttp/4.12.0";
const HAPP_HEADERS = {
  "User-Agent": HAPP_UA,
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Happ-App": "Happ",
  "X-Happ-Platform": "android",
  "Connection": "keep-alive",
};

// HTTP fetch с следованием за редиректами
async function fetchWithRedirects(url, headers, max = 5) {
  let currentUrl = url;
  for (let i = 0; i < max; i++) {
    const res = await fetch(currentUrl, { method: "GET", headers, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      currentUrl = loc.startsWith("/")
        ? `${new URL(currentUrl).protocol}//${new URL(currentUrl).host}${loc}`
        : loc;
      continue;
    }
    return res;
  }
  return await fetch(currentUrl, { method: "GET", headers });
}

// Извлечение URL подписки из Happ redirect страницы
function extractUrlFromHtml(html, originalUrl) {
  const patterns = [
    /<meta[^>]+content=["'][^"']*url=([^"']+)["'][^>]*>/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]*>/i,
    /window\.location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
    /window\.open\(["']([^"']+)["']/i,
    /href=["']([^"']*(?:\/sub[/?]|token=)[^"']*)["']/i,
    /data-(?:url|link)=["']([^"']+)["']/i,
    /(https?:\/\/[^"'\s<>]+\.(?:workers\.dev|com|net|io)[^"'\s<>]*token=[^"'\s<>]*)/i,
  ];
  
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      let url = m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      if (url.startsWith("/")) {
        try {
          const base = new URL(originalUrl);
          url = `${base.protocol}//${base.host}${url}`;
        } catch {}
      }
      if (url !== originalUrl && (url.includes("token=") || url.includes("/sub"))) {
        return url;
      }
    }
  }
  return null;
}

// Безопасное base64 декодирование
function safeBase64(data) {
  try {
    const clean = data.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean + "=".repeat((4 - clean.length % 4) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

// Получение подписки с маскировкой
async function fetchSubscription(url) {
  try {
    const res = await fetchWithRedirects(url, HAPP_HEADERS);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    
    // HTML — пробуем извлечь URL подписки
    if (ct.includes("text/html") || text.trim().startsWith("<")) {
      const real = extractUrlFromHtml(text, url);
      if (real) {
        // Рекурсия с настоящей ссылкой
        return fetchSubscription(real);
      }
      return { ok: false, error: "HTML страница без ссылки на подписку" };
    }
    
    return { ok: true, content: text, contentType: ct };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Детектор формата
function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  
  // crypt4/crypt5
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) {
    return "crypt";
  }
  
  // Base64 (только base64 символы)
  if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 40) {
    const decoded = safeBase64(c);
    if (decoded && decoded.includes("://")) return "base64";
  }
  
  // JSON
  if (c.startsWith("{") || c.startsWith("[")) {
    try {
      JSON.parse(c);
      return "json";
    } catch {}
  }
  
  // YAML (Clash/Mihomo)
  if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) {
    return "yaml";
  }
  
  // vless/vmess/trojan/ss список
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^[a-z0-9]+:\/\//i.test(l))) {
    return "vless-list";
  }
  
  return "unknown";
}

// ═══════════════════════════════════════════
//  ПАРСЕРЫ ФОРМАТОВ
// ═══════════════════════════════════════════

// Парсер vless://vmess://trojan://ss://... списка
function parseVlessList(content) {
  const uris = [];
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (l && !l.startsWith("#") && /^[a-z0-9]+:\/\//i.test(l)) {
      uris.push(l);
    }
  }
  return { ok: true, uris, metadata: extractHeaders(content) };
}

// Парсер base64 списка
function parseBase64(content) {
  const decoded = safeBase64(content.replace(/\s/g, ""));
  if (!decoded) return { ok: false, error: "Invalid base64" };
  return parseVlessList(decoded);
}

// Извлечение #headers из подписки
function extractHeaders(content) {
  const meta = {};
  for (const line of content.split("\n")) {
    if (line.startsWith("#")) {
      const m = line.match(/^#([a-z0-9-]+):\s*(.+)$/i);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  return meta;
}

// Парсер YAML (Clash/Mihomo)
function parseYaml(content) {
  try {
    const cfg = yaml.load(content);
    const uris = [];
    const proxies = cfg?.proxies || [];
    
    for (const p of proxies) {
      const uri = proxyToUri(p);
      if (uri) uris.push(uri);
    }
    
    return {
      ok: true,
      uris,
      metadata: extractHeaders(content),
      title: cfg?.["profile-title"] || cfg?.name,
      interval: cfg?.["profile-update-interval"],
    };
  } catch (e) {
    return { ok: false, error: `YAML: ${e.message}` };
  }
}

// Конвертация proxy из YAML в URI
function proxyToUri(p) {
  if (!p || !p.type) return null;
  const t = p.type.toLowerCase();
  const name = p.name || "Server";
  
  if (t === "vless") {
    const params = new URLSearchParams();
    if (p.network) params.set("type", p.network);
    if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
    if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
    if (p["grpc-opts"]?.["grpc-service-name"]) params.set("serviceName", p["grpc-opts"]["grpc-service-name"]);
    if (p["reality-opts"]?.["public-key"]) params.set("pbk", p["reality-opts"]["public-key"]);
    if (p["reality-opts"]?.["short-id"]) params.set("sid", p["reality-opts"]["short-id"]);
    if (p.tls) params.set("security", "tls");
    else if (p["reality-opts"]) params.set("security", "reality");
    if (p.sni) params.set("sni", p.sni);
    if (p["client-fingerprint"]) params.set("fp", p["client-fingerprint"]);
    if (p.flow) params.set("flow", p.flow);
    const q = params.toString();
    return `vless://${p.uuid}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "vmess") {
    const v = {
      v: "2", ps: name, add: p.server, port: p.port, id: p.uuid,
      aid: p.alterId || 0, net: p.network || "tcp", type: "none",
      host: p["ws-opts"]?.headers?.Host || "", path: p["ws-opts"]?.path || "",
      tls: p.tls ? "tls" : "", sni: p.sni || "",
    };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  
  if (t === "trojan") {
    const params = new URLSearchParams();
    params.set("security", "tls");
    if (p.network) params.set("type", p.network);
    if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
    if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
    if (p.sni) params.set("sni", p.sni);
    const q = params.toString();
    return `trojan://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "ss" || t === "shadowsocks") {
    const ui = btoa(`${p.cipher}:${p.password}`);
    return `ss://${ui}@${p.server}:${p.port}#${encodeURIComponent(name)}`;
  }
  
  if (t === "hysteria" || t === "hysteria2") {
    const params = new URLSearchParams();
    if (p.sni) params.set("sni", p.sni);
    if (p["obfs-password"]) params.set("obfs", "salamander");
    params.set("upmbps", p.up || "100");
    params.set("downmbps", p.down || "100");
    const q = params.toString();
    return `hysteria2://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "tuic") {
    const params = new URLSearchParams();
    if (p.sni) params.set("sni", p.sni);
    if (p["alpn"]) params.set("alpn", Array.isArray(p.alpn) ? p.alpn.join(",") : p.alpn);
    if (p["congestion-controller"]) params.set("congestion_control", p["congestion-controller"]);
    const q = params.toString();
    return `tuic://${p.uuid}:${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "wireguard" || t === "wg") {
    const params = new URLSearchParams();
    if (p["private-key"]) params.set("pk", p["private-key"]);
    if (p["public-key"]) params.set("public_key", p["public-key"]);
    if (p.ip) params.set("address", p.ip);
    if (p.dns) params.set("dns", p.dns);
    const q = params.toString();
    return `wg://${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// Парсер JSON (Xray/Sing-box/Hiddify/V2RayTun)
function parseJson(content) {
  try {
    const data = JSON.parse(content);
    const uris = [];
    
    // Xray: { outbounds: [...] }
    if (data.outbounds && Array.isArray(data.outbounds)) {
      for (const ob of data.outbounds) {
        const uri = xrayToUri(ob);
        if (uri) uris.push(uri);
      }
    }
    
    // Sing-box: { outbounds: [...] } (похож но другая структура)
    // уже покрыт выше через xrayToUri
    
    // Hiddify/V2RayTun: { configs: [{ url: "..." }] }
    if (data.configs && Array.isArray(data.configs)) {
      for (const c of data.configs) {
        if (typeof c === "string") uris.push(c);
        else if (c?.url) uris.push(c.url);
        else if (c?.config) uris.push(c.config);
      }
    }
    
    // Массив строк или объектов
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "string" && item.includes("://")) uris.push(item);
        else if (item?.type) {
          const uri = proxyToUri(item);
          if (uri) uris.push(uri);
        }
      }
    }
    
    // Один объект с type
    if (data?.type && !Array.isArray(data)) {
      const uri = proxyToUri(data);
      if (uri) uris.push(uri);
    }
    
    if (uris.length === 0) return { ok: false, error: "JSON не содержит конфигов" };
    return { ok: true, uris, metadata: {} };
  } catch (e) {
    return { ok: false, error: `JSON: ${e.message}` };
  }
}

// Конвертация Xray outbound в URI
function xrayToUri(ob) {
  if (!ob || !ob.protocol) return null;
  const proto = ob.protocol.toLowerCase();
  const name = ob.tag || "Server";
  
  if (proto === "vless" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0];
    const usr = srv.users?.[0];
    if (!usr) return null;
    const params = new URLSearchParams();
    const ss = ob.streamSettings || {};
    if (ss.network) params.set("type", ss.network);
    if (ss.security) params.set("security", ss.security);
    if (ss.network === "ws") {
      if (ss.wsSettings?.path) params.set("path", ss.wsSettings.path);
      if (ss.wsSettings?.headers?.Host) params.set("host", ss.wsSettings.headers.Host);
    }
    if (ss.network === "grpc") {
      if (ss.grpcSettings?.serviceName) params.set("serviceName", ss.grpcSettings.serviceName);
    }
    if (ss.realitySettings) {
      params.set("security", "reality");
      if (ss.realitySettings.serverName) params.set("sni", ss.realitySettings.serverName);
      if (ss.realitySettings.publicKey) params.set("pbk", ss.realitySettings.publicKey);
      if (ss.realitySettings.shortId) params.set("sid", ss.realitySettings.shortId);
    }
    if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
    if (usr.flow) params.set("flow", usr.flow);
    const q = params.toString();
    return `vless://${usr.id}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (proto === "vmess" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0];
    const usr = srv.users?.[0];
    if (!usr) return null;
    const ss = ob.streamSettings || {};
    const v = {
      v: "2", ps: name, add: srv.address, port: srv.port, id: usr.id,
      aid: usr.alterId || 0, net: ss.network || "tcp", type: "none",
      host: ss.wsSettings?.headers?.Host || "", path: ss.wsSettings?.path || "",
      tls: ss.security === "tls" ? "tls" : "",
    };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  
  if (proto === "trojan" && ob.settings?.servers?.[0]) {
    const srv = ob.settings.servers[0];
    const params = new URLSearchParams();
    const ss = ob.streamSettings || {};
    params.set("security", "tls");
    if (ss.network) params.set("type", ss.network);
    if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
    const q = params.toString();
    return `trojan://${srv.password}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (proto === "shadowsocks" && ob.settings?.servers?.[0]) {
    const srv = ob.settings.servers[0];
    const ui = btoa(`${srv.method}:${srv.password}`);
    return `ss://${ui}@${srv.address}:${srv.port}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// Парсер crypt5/crypt4
function parseCrypt(content) {
  // Пытаемся достать base64 часть
  const m = content.match(/^crypt[45]:\/\/(.+)$/i);
  if (!m) return { ok: false, error: "Некорректный crypt формат" };
  
  const encoded = m[1];
  const decoded = safeBase64(encoded);
  
  if (decoded && decoded.includes("://")) {
    // Удалось расшифровать как base64
    return parseVlessList(decoded);
  }
  
  return {
    ok: false,
    error: `⚠️ <b>crypt5/crypt4</b> — зашифрованный формат Happ/Hiddify\n\n` +
           `Требуется AES-ключ для дешифровки.\n\n` +
           `💡 <b>Решение:</b> открой ссылку в Happ или Hiddify → экспортируй как обычную vless подписку → отправь мне снова.`
  };
}

// Главная функция декодера
async function decodeSubscription(url) {
  const result = await fetchSubscription(url);
  if (!result.ok) return { ok: false, error: `Ошибка получения: ${result.error}` };
  
  const format = detectFormat(result.content);
  
  switch (format) {
    case "vless-list": return parseVlessList(result.content);
    case "base64": return parseBase64(result.content);
    case "yaml": return parseYaml(result.content);
    case "json": return parseJson(result.content);
    case "crypt": return parseCrypt(result.content);
    case "empty": return { ok: false, error: "Пустая подписка" };
    default:
      return {
        ok: false,
        error: `❓ Неизвестный формат\n\nContent-Type: <code>${result.contentType}</code>\n\nПервые 200 символов:\n<pre>${escapeHtml(result.content.substring(0, 200))}</pre>`
      };
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════
//  ПОСТРОЕНИЕ ФАЙЛА ПОДПИСКИ
// ═══════════════════════════════════════════
function buildFile(state, uris = [], defaults = {}) {
  const lines = [];
  const title = state.title || defaults.title || "My Subscription";
  const interval = state.interval || defaults.interval || 4;
  
  lines.push(`#profile-title: ${title}`);
  lines.push(`#profile-update-interval: ${interval}`);
  lines.push(`#subscription-userinfo: upload=0; download=0; total=536870912000; expire=0`);
  
  if (state.webpage) lines.push(`#profile-web-page-url: ${state.webpage}`);
  if (state.announce) lines.push(`#announce: ${state.announce}`);
  
  lines.push("");
  if (uris.length > 0) lines.push(...uris);
  
  return lines.join("\n");
}

// ═══════════════════════════════════════════
//  FSM ШАГИ
// ═══════════════════════════════════════════
const STEP_MSG = {
  title: `📝 <b>Шаг 1/4 — Имя подписки</b>

Как будет называться твоя подписка в приложении?

<i>Пример:</i> <code>🟦StekloVPN whitelist 🦆</code>

Отправь <code>none</code> чтобы пропустить.`,

  announce: `📢 <b>Шаг 2/4 — Описание</b>

Объявление для пользователей (видно в приложении).

<i>Пример:</i> <code>✨ Бесплатный VPN, подпишись @free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  webpage: `🌐 <b>Шаг 3/4 — Ссылка поддержки</b>

Ссылка на канал или поддержку.

<i>Пример:</i> <code>https://t.me/free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  interval: `⏰ <b>Шаг 4/4 — Интервал обновления</b>

Через сколько часов приложение должно обновлять подписку?

<i>Пример:</i> <code>4</code>

Отправь <code>none</code> чтобы пропустить.`,
};

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
        [{ text: "🗑 Удалить", callback_data: "delete" }],
      ]
    };
    
    await sendMessage(
      cfg.telegramToken, chatId,
      `✅ <b>Подписка создана!</b>

━━━━━━━━━━━━━━━━━━━━
📡 <b>Серверов:</b> <code>${uris.length}</code>
🔗 <b>Raw ссылка:</b>
<code>${rawUrl}</code>
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

// ═══════════════════════════════════════════
//  ГЛАВНЫЙ ОБРАБОТЧИК
// ═══════════════════════════════════════════
async function handleUpdate(update, cfg) {
  // Callback кнопки
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    await tgRequest(cfg.telegramToken, "answerCallbackQuery", { callback_query_id: cb.id });
    
    if (cb.data === "create") {
      await setState(cfg, chatId, { step: "title" });
      await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
    } else if (cb.data === "decode") {
      await sendMessage(cfg.telegramToken, chatId,
        `🔍 <b>Режим декодирования</b>

Отправь мне URL подписки (начинается с <code>http</code>) или используй:
<code>/decode https://...</code>

Я маскируюсь под <b>Happ</b> 🥷 и расшифрую:
✅ YAML (Clash/Mihomo)
✅ JSON (Xray/Sing-box/Hiddify)
✅ Base64
✅ VLESS/VMess/Trojan списки
⚠️ crypt5/crypt4 (нужен ключ)`,
        null, "HTML"
      );
    } else if (cb.data === "my") {
      await cmdMy(cfg, chatId);
    } else if (cb.data === "export") {
      await cmdExport(cfg, chatId);
    } else if (cb.data === "delete") {
      await cmdDelete(cfg, chatId);
    } else if (cb.data === "help") {
      await cmdHelp(cfg, chatId);
    }
    return;
  }
  
  if (!update.message) return;
  
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";
  
  const state = await getState(cfg, chatId);
  
  // Ответ на шаг FSM
  if (state && state.step && !text.startsWith("/")) {
    await handleStepAnswer(cfg, chatId, text, state);
    return;
  }
  
  // Автоматическое декодирование по URL
  if (!text.startsWith("/") && /^https?:\/\//.test(text.trim())) {
    await cmdDecode(cfg, chatId, text.trim());
    return;
  }
  
  if (!text.startsWith("/")) return;
  
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  
  if (cmd === "/start") return cmdStart(cfg, chatId, userId);
  if (cmd === "/help") return cmdHelp(cfg, chatId);
  if (cmd === "/create") return cmdCreate(cfg, chatId);
  if (cmd === "/decode") return cmdDecode(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/my") return cmdMy(cfg, chatId);
  if (cmd === "/export") return cmdExport(cfg, chatId);
  if (cmd === "/add") return cmdAdd(cfg, chatId, parts.slice(1).join(" "));
  if (cmd === "/delete") return cmdDelete(cfg, chatId);
  if (cmd === "/cancel") return cmdCancel(cfg, chatId);
  if (cmd === "/users") return cmdUsers(cfg, chatId, userId);
  if (cmd === "/stats") return cmdStats(cfg, chatId, userId);
}

// ═══════════════════════════════════════════
//  КОМАНДЫ
// ═══════════════════════════════════════════

async function cmdStart(cfg, chatId, userId) {
  await clearState(cfg, chatId);
  
  const kb = {
    inline_keyboard: [
      [
        { text: "✨ Создать подписку", callback_data: "create" },
        { text: "🔍 Декодер", callback_data: "decode" },
      ],
      [
        { text: "📋 Моя подписка", callback_data: "my" },
        { text: "📤 Экспорт", callback_data: "export" },
      ],
      [{ text: "ℹ️ Помощь", callback_data: "help" }],
    ]
  };
  
  await sendMessage(
    cfg.telegramToken, chatId,
    `━━━━━━━━━━━━━━━━━━━━━━━
       🌊 <b>OceaniaVPN Bot</b>
━━━━━━━━━━━━━━━━━━━━━━━

👋 <b>Привет!</b>

Создай персональную VPN подписку или расшифруй чужую.

<b>🎯 Что я умею:</b>

✨ <b>/create</b> — пошаговое создание подписки
🔍 <b>/decode</b> — расшифровка чужой подписки
   (YAML / JSON / Base64 / crypt5)
   с маскировкой под <b>Happ</b> 🥷
➕ <b>/add</b> — добавить сервер
📤 <b>/export</b> — получить raw ссылку
🗑 <b>/delete</b> — удалить подписку

💡 <b>Лайфхак:</b> просто отправь URL подписки — я её сам расшифрую!

<i>Выбери действие ниже:</i>`,
    kb
  );
}

async function cmdHelp(cfg, chatId) {
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
/export — получить raw ссылку
/add &lt;url&gt; — добавить сервер
/delete — удалить подписку
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
• WireGuard

━━━━━━━━━━━━━━━━━━━━━━━
<b>📲 Приложения</b>
━━━━━━━━━━━━━━━━━━━━━━━

• <b>Android:</b> v2rayNG, Hiddify, NekoBox
• <b>iOS:</b> Shadowrocket, Streisand
• <b>Desktop:</b> Hiddify, Clash Meta, V2rayN`
  );
}

async function cmdCreate(cfg, chatId) {
  await setState(cfg, chatId, { step: "title" });
  await sendMessage(cfg.telegramToken, chatId, STEP_MSG.title);
}

async function cmdCancel(cfg, chatId) {
  const state = await getState(cfg, chatId);
  if (state) {
    await clearState(cfg, chatId);
    await sendMessage(cfg.telegramToken, chatId, `❌ <b>Создание отменено.</b>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `ℹ️ Нет активного процесса.`);
  }
}

async function cmdDecode(cfg, chatId, url) {
  if (!url || !url.startsWith("http")) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>
<code>/decode https://example.com/sub</code>

Или просто отправь URL сообщением.`);
  }
  
  const loadingMsg = await sendMessage(
    cfg.telegramToken, chatId,
    `⏳ <b>Декодирую подписку...</b>

🔗 URL: <code>${escapeHtml(url.substring(0, 60))}...</code>
🥷 Маскируюсь под Happ
🔍 Определяю формат...`
  );
  
  const result = await decodeSubscription(url);
  
  if (!result.ok) {
    return editMessage(
      cfg.telegramToken, chatId, loadingMsg.result?.message_id,
      `❌ <b>Не удалось расшифровать</b>\n\n${result.error}`
    );
  }
  
  const uris = result.uris || [];
  const timestamp = Date.now().toString(36);
  const filename = `decoded_${chatId}_${timestamp}.txt`;
  
  const meta = result.metadata || {};
  const hostname = (() => { try { return new URL(url).hostname; } catch { return "subscription"; } })();
  
  const content = buildFile(
    {
      title: meta["profile-title"] || `Decoded • ${hostname}`,
      interval: meta["profile-update-interval"] || 4,
      webpage: meta["profile-web-page-url"] || url,
      announce: meta.announce || null,
    },
    uris
  );
  
  const res = await createOrUpdateFile(cfg, filename, content, `Decode subscription from ${hostname}`);
  
  if (res.content || res.sha) {
    const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${filename}`;
    
    // Подсчёт протоколов
    const stats = { vless: 0, vmess: 0, trojan: 0, ss: 0, other: 0 };
    for (const u of uris) {
      if (u.startsWith("vless://")) stats.vless++;
      else if (u.startsWith("vmess://")) stats.vmess++;
      else if (u.startsWith("trojan://")) stats.trojan++;
      else if (u.startsWith("ss://")) stats.ss++;
      else stats.other++;
    }
    
    const kb = {
      inline_keyboard: [
        [{ text: "📋 Открыть подписку", url: rawUrl }],
        [{ text: "💾 Добавить к моей подписке", callback_data: "merge_" + filename }],
      ]
    };
    
    await editMessage(
      cfg.telegramToken, chatId, loadingMsg.result?.message_id,
      `✅ <b>Успешно расшифровано!</b>

━━━━━━━━━━━━━━━━━━━━
📡 <b>Серверов найдено:</b> <code>${uris.length}</code>

<b>Протоколы:</b>
${stats.vless ? `• VLESS: <b>${stats.vless}</b>\n` : ""}${stats.vmess ? `• VMess: <b>${stats.vmess}</b>\n` : ""}${stats.trojan ? `• Trojan: <b>${stats.trojan}</b>\n` : ""}${stats.ss ? `• Shadowsocks: <b>${stats.ss}</b>\n` : ""}${stats.other ? `• Другое: <b>${stats.other}</b>\n` : ""}
🔗 <b>Raw ссылка:</b>
<code>${rawUrl}</code>
━━━━━━━━━━━━━━━━━━━━

💡 Вставь в v2rayNG / Hiddify / Shadowrocket`,
      kb
    );
  } else {
    await editMessage(cfg.telegramToken, chatId, loadingMsg.result?.message_id, `❌ Ошибка сохранения`);
  }
}

async function cmdMy(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId,
      `📭 <b>Подписки нет</b>

Создай через /create или расшифруй через /decode`);
  }
  
  const lines = content.split("\n");
  const headers = lines.filter(l => l.startsWith("#"));
  const links = lines.filter(l => l.trim() && !l.startsWith("#"));
  
  let msg = `📋 <b>Твоя подписка</b>\n\n`;
  msg += `<b>Заголовки:</b>\n<pre>${escapeHtml(headers.join("\n"))}</pre>\n`;
  msg += `<b>Серверов:</b> <code>${links.length}</code>\n\n`;
  msg += `<b>Ссылки:</b>\n<pre>${escapeHtml(links.join("\n").substring(0, 3000))}</pre>`;
  
  if (links.join("\n").length > 3000) {
    msg += `\n<i>... (слишком длинно, используй /export)</i>`;
  }
  
  const kb = {
    inline_keyboard: [
      [{ text: "📤 Экспорт", callback_data: "export" }],
      [{ text: "🗑 Удалить", callback_data: "delete" }],
    ]
  };
  
  await sendMessage(cfg.telegramToken, chatId, msg, kb);
}

async function cmdExport(cfg, chatId) {
  const content = await getFileContent(cfg, `user_${chatId}.txt`);
  if (!content) {
    return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create или /decode`);
  }
  
  const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/user_${chatId}.txt`;
  
  const kb = {
    inline_keyboard: [
      [{ text: "🔗 Открыть", url: rawUrl }],
    ]
  };
  
  await sendMessage(
    cfg.telegramToken, chatId,
    `📤 <b>Экспорт подписки</b>

━━━━━━━━━━━━━━━━━━━━
🔗 <b>Raw ссылка:</b>
<code>${rawUrl}</code>
━━━━━━━━━━━━━━━━━━━━

<b>Импортируй в:</b>
• <b>v2rayNG</b> → Подписка → +
• <b>Hiddify</b> → Добавить профиль
• <b>Shadowrocket</b> → + → Тип: Subscribe
• <b>Clash Meta</b> → Profile → Add`,
    kb
  );
}

async function cmdAdd(cfg, chatId, url) {
  if (!url) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Используй:</b>
<code>/add vless://...</code>`);
  }
  
  const userFile = `user_${chatId}.txt`;
  const existing = await getFileContent(cfg, userFile);
  
  if (!existing) {
    return sendMessage(cfg.telegramToken, chatId, `📭 Сначала /create`);
  }
  
  const lines = existing.split("\n");
  const headers = [];
  const links = [];
  
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") headers.push(line);
    else links.push(line);
  }
  
  // Если URL — подписка, декодируем её
  let toAdd = [url];
  if (/^https?:\/\//.test(url)) {
    const result = await decodeSubscription(url);
    if (result.ok && result.uris?.length > 0) {
      toAdd = result.uris;
    } else {
      return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось декодировать: ${result.error}`);
    }
  } else if (!url.includes("://")) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Не похоже на VPN ссылку.`);
  }
  
  links.push(...toAdd);
  const updated = headers.join("\n") + "\n" + links.join("\n");
  
  const res = await createOrUpdateFile(cfg, userFile, updated, `Add ${toAdd.length} nodes`);
  if (res.content || res.sha) {
    await sendMessage(cfg.telegramToken, chatId,
      `✅ <b>Добавлено серверов:</b> <code>${toAdd.length}</code>
📊 <b>Всего:</b> <code>${links.length}</code>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `❌ Ошибка`);
  }
}

async function cmdDelete(cfg, chatId) {
  const res = await deleteFile(cfg, `user_${chatId}.txt`, `Delete user ${chatId}`);
  if (res.commit) {
    await sendMessage(cfg.telegramToken, chatId, `🗑 <b>Подписка удалена</b>`);
  } else {
    await sendMessage(cfg.telegramToken, chatId, `📭 У тебя нет подписки`);
  }
}

async function cmdUsers(cfg, chatId, userId) {
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

async function cmdStats(cfg, chatId, userId) {
  if (userId !== cfg.adminId) return sendMessage(cfg.telegramToken, chatId, `⛔️ Нет прав`);
  const users = await listAllUsers(cfg);
  await sendMessage(cfg.telegramToken, chatId,
    `📊 <b>Статистика OceaniaVPN</b>

👥 <b>Пользователей:</b> <code>${users.length}</code>
📁 <b>Файлов:</b> <code>${users.length}</code>`);
}

// ═══════════════════════════════════════════
//  ВХОД
// ═══════════════════════════════════════════
export default {
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><title>OceaniaVPN</title><style>body{font-family:system-ui;max-width:600px;margin:50px auto;padding:20px;background:#0a0e27;color:#fff;text-align:center}.logo{font-size:60px;margin-bottom:20px}h1{background:linear-gradient(90deg,#00d4ff,#0099ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head><body><div class="logo">🌊</div><h1>OceaniaVPN Bot</h1><p>🚀 Активен и готов к работе</p><p>🥷 Декодер подписок с маскировкой под Happ</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
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
      } catch (e) {
        console.error(e);
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }
    
    return new Response("Method not allowed", { status: 405 });
  },
};
