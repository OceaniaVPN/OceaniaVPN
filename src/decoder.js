import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";
import { TARGET_USER_AGENTS } from "./useragents.js";
import { connect } from "cloudflare:sockets";

const BLOCKED_DOMAINS = [
  "okeaniavpn.dimastekolnikov13.workers.dev",
  "sub.chkav-vpn.workers.dev"
];

const TRUSTED_BOT_SECRET = "d2a27a0c9593535ad6a695917e4c022b35f2376b6b84a66c8";

function normalizeText(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .trim();
}

function isStubResponse(text) {
  const trimmed = normalizeText(text);
  if (!trimmed) return true;
  if (trimmed.length > 2000) return false;
  const hasConfigSignal = /(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(trimmed) ||
    /(?:\"protocol\"\s*:|\"outbounds\"\s*:|\"proxies\"\s*:|^proxies\s*:|^proxy-groups\s*:)/im.test(trimmed);
  if (hasConfigSignal) return false;
  const stubs = ["0.0.0.0", "00000000-0000", "App not supported", "Unsupported app", "invalid subscription", "subscription not found"];
  return stubs.some(s => trimmed.toLowerCase().includes(s.toLowerCase()));
}

function isTemporaryMessage(text) {
  const t = normalizeText(text).toLowerCase();
  if (!t || t.length > 800) return false;
  return /^(?:loading|wait|please wait|processing|updating|загрузка|загружается|подождите|обновляется|обрабатывается)[.!… ]*$/i.test(t) ||
    /^(?:конфигурация|подписка).{0,80}(?:готов|обнов|через).{0,40}(?:секунд|минут)/i.test(t);
}

async function fetchWithTimeout(url, options, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function fetchWithRedirects(url, headers, max = 5) {
  let currentUrl = url;
  for (let i = 0; i < max; i++) {
    const res = await fetchWithTimeout(currentUrl, { method: "GET", headers, redirect: "manual" }, 6000);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      // Некоторые Happ/Hiddify шлюзы редиректят прямо в happ://... .
      // Не пытаемся передать такой URI в fetch(): возвращаем его как тело,
      // чтобы следующий этап декодера смог разобрать envelope.
      if (/^(?:happ|incy|v2raytun):\/\//i.test(loc.trim())) {
        return new Response(loc.trim(), {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" }
        });
      }
      currentUrl = new URL(loc, currentUrl).toString();
      const redirectTarget = extractRedirectTarget(currentUrl);
      if (redirectTarget) currentUrl = new URL(redirectTarget, currentUrl).toString();
      continue;
    }
    return res;
  }
  return await fetchWithTimeout(currentUrl, { method: "GET", headers }, 6000);
}

function extractRedirectTarget(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname.includes("happ-redirect") || urlObj.pathname.includes("redirect")) {
      return urlObj.searchParams.get("url") || urlObj.searchParams.get("sub") || urlObj.searchParams.get("link") || urlObj.searchParams.get("target") || null;
    }
    return urlObj.searchParams.get("url") || null;
  } catch { return null; }
}

function buildHappHeaders(ua, isFirstRequest = false, trusted = false) {
  const hwidMatch = ua.match(/Android\/(\d+)/);
  const hwid = hwidMatch ? hwidMatch[1] : Math.floor(Math.random() * 1e19).toString();
  const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const headers = {
    "User-Agent": ua, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9,ru;q=0.8", "Accept-Encoding": "gzip, deflate, br", "Connection": "keep-alive", "DNT": "1", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "cross-site", "X-Client-Version": "3.26.3", "X-Client-Platform": "Android", "X-Request-ID": requestId, "X-App-Name": "Happ",
    ...(isFirstRequest && { "X-First-Launch": "true", "X-Install-Time": Date.now() - 86400000 * (Math.floor(Math.random() * 30) + 1).toString() }),
  };
  if (ua.includes("Happ")) {
    headers["X-Happ-HWID"] = hwid; headers["X-Device-ID"] = hwid; headers["X-Happ-App"] = "Happ"; headers["X-Happ-Platform"] = ua.includes("iOS") ? "ios" : "android";
  }
  if (ua.includes("V2raytun")) { headers["X-V2Ray-Version"] = "5.25.81"; headers["X-App-Type"] = "v2ray"; }
  if (ua.includes("INCY")) headers["X-INCY-Version"] = "3.4.2";
  if (trusted) headers["X-Bot-Secret"] = TRUSTED_BOT_SECRET;
  return headers;
}

function addCandidate(set, value, originalUrl = "") {
  if (!value || typeof value !== "string") return;
  let v = value.trim().replace(/^['\"<\(]+|[\"'>\),;]+$/g, "");
  v = v.replace(/&amp;/gi, "&").replace(/\\\//g, "/");
  try { v = decodeURIComponent(v); } catch {}
  if (/^https?:\/\//i.test(v) && v !== originalUrl && !/0\.0\.0\.0|00000000-0000/i.test(v)) set.add(v);
}

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  html = normalizeText(html);
  const direct = html.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
  direct.forEach(u => addCandidate(foundUrls, u, originalUrl));

  const happLinks = html.match(/(?:happ|incy|v2raytun):\/\/[^\s"'<>]+/gi) || [];
  for (const link of happLinks) {
    const cleanLink = link.replace(/["'>]/g, "");
    let decoded = cleanLink;
    try { decoded = decodeURIComponent(cleanLink); } catch {}
    const addMatch = cleanLink.match(/(?:happ|incy|v2raytun):\/\/add\/(.+)$/i);
    if (addMatch) addCandidate(foundUrls, addMatch[1], originalUrl);
    const cryptMatch = cleanLink.match(/happ:\/\/crypt\d*\/(.+)$/i);
    if (cryptMatch) addCandidate(foundUrls, safeBase64(cryptMatch[1]), originalUrl);
    (decoded.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => addCandidate(foundUrls, u, originalUrl));
    const b64 = decoded.match(/(?:happ|incy|v2raytun):\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{16,})/i);
    if (b64) {
      const d = safeBase64(b64[1]);
      (d?.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => addCandidate(foundUrls, u, originalUrl));
    }
  }

  const encoded = html.match(/(?:url|link|sub|target|redirect|subscription|config|payload)=([^&\s"'>]+)/gi) || [];
  for (const match of encoded) {
    const value = match.replace(/^[^=]+=\s*/, "");
    addCandidate(foundUrls, value, originalUrl);
    const b64 = safeBase64(value);
    if (b64) (b64.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => addCandidate(foundUrls, u, originalUrl));
  }

  const attrs = html.match(/(?:data-(?:url|link|sub|subscription|config|clipboard-text)|(?:href|src))=["']([^"']+)["']/gi) || [];
  for (const attr of attrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m) addCandidate(foundUrls, m[1], originalUrl);
  }

  const jsValues = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config|target)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsValues) {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m) addCandidate(foundUrls, m[1], originalUrl);
  }

  const escapedUrls = html.match(/https?:\\?\/\\?\/[^\s"'<>\\]+/gi) || [];
  escapedUrls.forEach(u => addCandidate(foundUrls, u, originalUrl));

  const b64Blocks = html.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) || [];
  for (const b64 of b64Blocks.slice(0, 30)) {
    const decoded = safeBase64(b64);
    if (decoded) (decoded.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => addCandidate(foundUrls, u, originalUrl));
  }

  return Array.from(foundUrls).filter(url => url.startsWith("http") && url !== originalUrl);
}

function unwrapEnvelope(content) {
  const c = normalizeText(content);
  if (!c) return null;
  const add = c.match(/^(?:happ|incy|v2raytun):\/\/add\/(.+)$/i);
  if (add) {
    let value = add[1].trim();
    try { value = decodeURIComponent(value); } catch {}
    if (/^https?:\/\//i.test(value)) return value;
    const decoded = safeBase64(value);
    if (decoded && /^https?:\/\//i.test(decoded.trim())) return decoded.trim();
  }
  return null;
}

function hasParsableContent(text) {
  const c = normalizeText(text);
  if (!c) return false;
  if (/(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(c)) return true;
  if (/^(?:happ|incy|v2raytun):\/\//i.test(c)) return true;
  if (/^\s*[\[{]/.test(c)) {
    try { JSON.parse(c); return true; } catch {}
  }
  if (/^(?:proxies|proxy-groups|mixed-port|port|mode)\s*:/im.test(c)) return true;
  if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(c.replace(/\s/g, ""))) {
    const d = safeBase64(c);
    if (d && /(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard):\/\//i.test(d)) return true;
  }
  return false;
}

async function fetchSubscription(url, trusted = false) {
  try {
    const lowerUrl = url.toLowerCase();
    if (BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()))) return { ok: false, error: "🚫 Домен заблокирован", attempts: 0 };
    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget ? new URL(redirectTarget, url).toString() : url;
    let lastError = "Неизвестная ошибка", attempts = 0, bestContent = null, bestContentType = null;
    const MAX_ATTEMPTS = Math.min(8, TARGET_USER_AGENTS.length);
    const RETRY_DELAYS = [0, 250, 500, 1000, 1500, 2500, 4000, 5000];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts = i + 1;
      const ua = TARGET_USER_AGENTS[i];
      try {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[i] || 1000));
        const res = await fetchWithRedirects(actualUrl, buildHappHeaders(ua, i === 0, trusted));
        if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
        const text = normalizeText(await res.text());
        const ct = res.headers.get("content-type") || "";
        if (!text) { lastError = "Пустой ответ"; continue; }
        if (isTemporaryMessage(text)) { lastError = "Сервер вернул временное сообщение"; continue; }
        if (isStubResponse(text)) { lastError = "Сервер вернул заглушку"; continue; }

        const envelopeUrl = unwrapEnvelope(text);
        if (envelopeUrl && envelopeUrl !== actualUrl) {
          try {
            const nested = await fetchWithRedirects(envelopeUrl, buildHappHeaders(ua, false, trusted));
            if (nested.ok) {
              const nestedText = normalizeText(await nested.text());
              if (nestedText) return { ok: true, content: nestedText, contentType: nested.headers.get("content-type") || "text/plain", attempts };
            }
          } catch {}
        }

        const isHtml = ct.includes("text/html") || /<html|<!doctype|<body|<script/i.test(text);
        if (isHtml) {
          const allUrls = extractAllUrlsFromHtml(text, url).slice(0, 8);
          if (allUrls.length > 0) {
            const allContents = [];
            for (const subUrl of allUrls) {
              try {
                const subRes = await fetchWithRedirects(subUrl, buildHappHeaders(ua, false, trusted));
                if (!subRes.ok) continue;
                const subText = normalizeText(await subRes.text());
                if (!subText || isStubResponse(subText) || isTemporaryMessage(subText)) continue;
                const subCt = subRes.headers.get("content-type") || "";
                if (/<html|<!doctype|<script/i.test(subText) || subCt.includes("text/html")) {
                  const nestedUrls = extractAllUrlsFromHtml(subText, subUrl).slice(0, 6);
                  for (const nestedUrl of nestedUrls) {
                    try {
                      const nestedRes = await fetchWithRedirects(nestedUrl, buildHappHeaders(ua, false, trusted));
                      if (nestedRes.ok) {
                        const nestedText = normalizeText(await nestedRes.text());
                        if (nestedText && !isStubResponse(nestedText) && !isTemporaryMessage(nestedText)) allContents.push(nestedText);
                      }
                    } catch {}
                  }
                } else allContents.push(subText);
              } catch {}
            }
            if (allContents.length > 0) return { ok: true, content: allContents.join("\n"), contentType: "text/plain", attempts };
          }
          if (hasParsableContent(text)) return { ok: true, content: text, contentType: ct, attempts };
          lastError = "HTML не содержит рабочей подписки";
          continue;
        }

        bestContent = text;
        bestContentType = ct;
        if (hasParsableContent(text) || text.includes("://")) return { ok: true, content: text, contentType: ct, attempts };
      } catch (e) { lastError = e.name === "AbortError" ? "Таймаут запроса" : e.message; }
    }
    if (bestContent) return { ok: true, content: bestContent, contentType: bestContentType, attempts };
    return { ok: false, error: `❌ <b>Не удалось получить подписку</b>\n\nПроверил <b>${attempts}</b> вариантов запроса.\n\nПоследняя ошибка: <code>${escapeHtml(lastError)}</code>\n\n💡 Попробуй прямую ссылку на подписку или экспорт из приложения, если исходная ссылка ведёт на страницу.`, attempts };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "Таймаут запроса", attempts: 0 };
    return { ok: false, error: `Ошибка сети: ${e.message}`, attempts: 0 };
  }
}

function detectFormat(content) {
  const c = normalizeText(content);
  if (!c) return "empty";
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  if (/<(?:!doctype|html|body|script)/i.test(c)) return "html";
  if (/^(?:happ|incy|v2raytun):\/\//i.test(c)) return "envelope";
  if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 20) {
    const decoded = safeBase64(c);
    if (decoded && /(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard):\/\//i.test(decoded)) return "base64";
  }
  if (c.startsWith("{") || c.startsWith("[")) { try { JSON.parse(c); return "json"; } catch {} }
  if (/\bproxies\s*:|\bproxy-groups\s*:|\bmixed-port\s*:/i.test(c)) return "yaml";
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard|wg):\/\//i.test(l))) return "vless-list";
  return "unknown";
}

function extractHostPort(uri) {
  try {
    if (uri.startsWith("vmess://")) { const decoded = safeBase64(uri.substring(8)); if (!decoded) return null; const json = JSON.parse(decoded); const port = parseInt(json.port, 10); if (json.add && port) return { host: json.add, port }; return null; }
    const m = uri.match(/@([^:/?#]+):(\d+)/);
    return m ? { host: m[1], port: parseInt(m[2], 10) } : null;
  } catch { return null; }
}

export async function checkServerAlive(uri, timeoutMs = 2500) {
  const hp = extractHostPort(uri);
  if (!hp || !hp.host || !hp.port) return false;
  let socket;
  try {
    socket = connect({ hostname: hp.host, port: hp.port });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
    await Promise.race([socket.opened, timeout]);
    return true;
  } catch { return false; }
  finally { try { if (socket) socket.close(); } catch {} }
}

export async function checkServersAlive(uris, { concurrency = 8, timeoutMs = 2500 } = {}) {
  const results = new Array(uris.length).fill(false);
  let idx = 0;
  async function worker() { while (idx < uris.length) { const i = idx++; results[i] = await checkServerAlive(uris[i], timeoutMs); } }
  const workerCount = Math.max(1, Math.min(concurrency, uris.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function decodeSubscription(url, trusted = false, pingCheck = false) {
  const result = await fetchSubscription(url, trusted);
  if (!result.ok) return { ok: false, error: result.error, attempts: result.attempts || 0 };
  if (isStubResponse(result.content)) return { ok: false, error: `❌ <b>Обнаружена заглушка!</b>\n\nСервер вернул фейковые ключи (0.0.0.0).`, attempts: result.attempts || 0 };
  const format = detectFormat(result.content);
  let parseResult;
  switch (format) {
    case "vless-list": parseResult = parseVlessList(result.content); break;
    case "base64": parseResult = parseBase64(result.content); break;
    case "yaml": parseResult = parseYaml(result.content); break;
    case "json": parseResult = parseJson(result.content); break;
    case "crypt": parseResult = parseCrypt(result.content); break;
    case "envelope": {
      const target = unwrapEnvelope(result.content);
      if (target) {
        const nested = await fetchSubscription(target, trusted);
        if (nested.ok) {
          return decodeSubscription(target, trusted, pingCheck);
        }
      }
      parseResult = { ok: false, error: "❌ Happ envelope не содержит доступной подписки." };
      break;
    }
    case "empty": parseResult = { ok: false, error: "Пустая подписка" }; break;
    case "html": parseResult = { ok: false, error: `❌ <b>HTML-страница или заглушка!</b>` }; break;
    default: parseResult = { ok: false, error: `❓ Неизвестный формат` };
  }
  if (!parseResult.ok || !parseResult.uris?.length) {
    for (const parser of [parseVlessList, parseBase64, parseYaml, parseJson]) {
      try { const candidate = parser(result.content); if (candidate?.ok && candidate.uris?.length) { parseResult = candidate; break; } } catch {}
    }
  }
  if (parseResult.ok && Array.isArray(parseResult.uris)) {
    const seen = new Set();
    parseResult.uris = parseResult.uris.filter(uri => {
      if (!uri || typeof uri !== "string") return false;
      const clean = uri.trim();
      if (!clean || seen.has(clean) || /0\.0\.0\.0|00000000-0000/i.test(clean)) return false;
      seen.add(clean); return true;
    });
    if (!parseResult.uris.length) { parseResult.ok = false; parseResult.error = "❌ Подписка получена, но рабочих конфигураций не найдено."; }
  }
  parseResult.attempts = result.attempts;
  if (pingCheck && parseResult.ok && parseResult.uris?.length > 0) {
    const alive = await checkServersAlive(parseResult.uris, { concurrency: 8, timeoutMs: 2500 });
    parseResult.aliveFlags = alive;
    parseResult.aliveCount = alive.filter(Boolean).length;
    parseResult.deadCount = alive.length - parseResult.aliveCount;
  }
  return parseResult;
}