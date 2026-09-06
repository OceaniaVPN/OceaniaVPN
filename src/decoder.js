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

function isStubResponse(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length > 2000) return false;
  const stubs = ["0.0.0.0", "00000000-0000", "127.0.0.1", "localhost", "App not supported", "not supported", "Unsupported app", "invalid subscription", "subscription not found"];
  return stubs.some(s => trimmed.includes(s));
}

function isTemporaryMessage(text) {
  if (!text) return false;
  const tempMessages = ["загружается", "loading", "загрузка", "wait", "подождите", "отгружается", "обновляется", "updating", "processing", "через", "минут", "секунд", "seconds", "minutes"];
  return tempMessages.some(s => text.toLowerCase().includes(s));
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function fetchWithRedirects(url, headers, max = 5) {
  let currentUrl = url;
  for (let i = 0; i < max; i++) {
    const res = await fetchWithTimeout(currentUrl, { method: "GET", headers, redirect: "manual" }, 8000);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      currentUrl = new URL(loc, currentUrl).toString();
      const redirectTarget = extractRedirectTarget(currentUrl);
      if (redirectTarget) currentUrl = new URL(redirectTarget, currentUrl).toString();
      continue;
    }
    return res;
  }
  return await fetchWithTimeout(currentUrl, { method: "GET", headers }, 8000);
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

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  html = html.replace(/&amp;/g, "&");
  const happLinks = html.match(/happ:\/\/[^\s"'<>]+/gi) || [];
  for (const link of happLinks) {
    const cleanLink = link.replace(/["'>]/g, "");
    const decoded = decodeURIComponent(cleanLink.replace("happ://", ""));
    const addMatch = cleanLink.match(/happ:\/\/add\/(.+)$/i);
    if (addMatch) { const extractedUrl = decodeURIComponent(addMatch[1]); if (extractedUrl.startsWith("http") && !extractedUrl.includes("0.0.0.0")) foundUrls.add(extractedUrl); }
    const cryptMatch = cleanLink.match(/happ:\/\/crypt\d*\/(.+)$/i);
    if (cryptMatch) { const decrypted = safeBase64(cryptMatch[1]); if (decrypted && decrypted.startsWith("http")) foundUrls.add(decrypted); }
    const direct = decoded.match(/https?:\/\/[^\s"'<>]+/gi);
    if (direct && !direct[0].includes("0.0.0.0")) foundUrls.add(direct[0]);
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) { const d = safeBase64(b64[1]); if (d) (d.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => { if (!u.includes("0.0.0.0")) foundUrls.add(u); }); }
  }
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) { const m = attr.match(/=["']([^"']+)["']/); if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) foundUrls.add(m[1]); }
  const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
  for (const m of onclickMatches) { const urlMatch = m.match(/https?:\/\/[^"'\s]+/); if (urlMatch && !urlMatch[0].includes("0.0.0.0")) foundUrls.add(urlMatch[0]); }
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsVars) { const m = v.match(/=\s*["']([^"']+)["']/); if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) foundUrls.add(m[1]); }
  const jsonInHtml = html.match(/<script[^>]*>\s*(?:var\s+config\s*=)?\s*({[\s\S]*?})\s*<\/script>/gi) || [];
  for (const block of jsonInHtml) { try { const jsonMatch = block.match(/{[\s\S]*?}/); if (jsonMatch) { const obj = JSON.parse(jsonMatch[0]); if (obj.url) foundUrls.add(obj.url); if (obj.subscription) foundUrls.add(obj.subscription); if (obj.config) foundUrls.add(obj.config); if (obj.link) foundUrls.add(obj.link); } } catch {} }
  const b64InHtml = html.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const b64 of b64InHtml) { try { const decoded = safeBase64(b64); if (decoded && decoded.startsWith("http")) foundUrls.add(decoded); } catch {} }
  const patterns = [/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i, /window\.location\.replace\(["']([^"']+)["']\)/i, /content=["'][^"']*url=([^"']+)["']/i, /href=["']([^"']+)["']/i];
  for (const p of patterns) { const matches = html.match(p); if (matches && matches[1]) { const url = matches[1].replace(/&amp;/g, "&"); if (url.startsWith("http") && url !== originalUrl && !url.includes("0.0.0.0")) foundUrls.add(url); } }
  const linkTags = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi) || [];
  for (const tag of linkTags) { const m = tag.match(/href=["']([^"']+)["']/i); if (m) { const href = m[1]; if ((href.includes("sub") || href.includes("token") || href.includes("config")) && !href.includes("0.0.0.0")) foundUrls.add(href); } }
  const anySub = html.match(/https?:\/\/[^\s"'<>]*?(?:sub|token=|key=|uuid=)[^\s"'<>]*/gi) || [];
  for (const s of anySub) { const url = s.replace(/["']/g, "").replace(/&amp;/g, "&"); if (!url.includes("0.0.0.0")) foundUrls.add(url); }
  const encodedUrlMatches = html.match(/(?:url|link|sub|target|redirect|subscription)=([^&\s"'>]+)/gi) || [];
  for (const match of encodedUrlMatches) { try { const decoded = decodeURIComponent(match.split("=")[1]); if (decoded.startsWith("http") && !decoded.includes("0.0.0.0") && !decoded.includes("00000000-0000")) foundUrls.add(decoded); } catch {} }
  if (foundUrls.size === 0) { const simpleLinks = html.match(/https?:\/\/[^\s"'<>]{20,}/gi) || []; for (const link of simpleLinks) if ((link.includes("sub") || link.includes("token") || link.includes("config")) && !link.includes("0.0.0.0")) foundUrls.add(link); }
  return Array.from(foundUrls).filter(url => url !== originalUrl && url.startsWith("http") && !url.includes("0.0.0.0") && !url.includes("00000000-0000"));
}

async function fetchSubscription(url, trusted = false) {
  try {
    const lowerUrl = url.toLowerCase();
    if (BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()))) return { ok: false, error: "🚫 Домен заблокирован", attempts: 0 };
    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget ? new URL(redirectTarget, url).toString() : url;
    let lastError = "Неизвестная ошибка", attempts = 0, bestContent = null, bestContentType = null;
    const MAX_ATTEMPTS = Math.min(8, TARGET_USER_AGENTS.length);
    const RETRY_DELAYS = [0, 500, 1000, 1500, 2500, 4000, 6000, 8000];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts = i + 1;
      const ua = TARGET_USER_AGENTS[i];
      try {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[i] || 8000));
        const res = await fetchWithRedirects(actualUrl, buildHappHeaders(ua, i === 0, trusted));
        if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
        const text = await res.text(), ct = res.headers.get("content-type") || "";
        if (isTemporaryMessage(text)) { lastError = "Сервер готовит конфиг (временное сообщение)"; continue; }
        if (isStubResponse(text)) { lastError = "Сервер вернул заглушку (0.0.0.0 / App not supported)"; continue; }
        const isHtml = ct.includes("text/html") || text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html") || text.includes("<body") || text.includes("<script");
        if (isHtml) {
          const allUrls = extractAllUrlsFromHtml(text, url);
          if (allUrls.length > 0) {
            const allContents = [];
            for (const subUrl of allUrls.slice(0, 3)) {
              try {
                const subRes = await fetchWithRedirects(subUrl, buildHappHeaders(ua, false, trusted));
                if (!subRes.ok) continue;
                const subText = await subRes.text(), subCt = subRes.headers.get("content-type") || "";
                if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
                  const nestedUrls = extractAllUrlsFromHtml(subText, subUrl).slice(0, 2);
                  for (const nestedUrl of nestedUrls) { try { const nestedRes = await fetchWithRedirects(nestedUrl, buildHappHeaders(ua, false, trusted)); if (nestedRes.ok) { const nestedText = await nestedRes.text(); if (!isStubResponse(nestedText) && !isTemporaryMessage(nestedText)) allContents.push(nestedText); } } catch {} }
                } else if (!isStubResponse(subText) && !isTemporaryMessage(subText)) allContents.push(subText);
              } catch {}
            }
            if (allContents.length > 0) return { ok: true, content: allContents.join("\n"), contentType: "text/plain", attempts };
          }
          lastError = "HTML не содержит рабочей подписки";
          continue;
        }
        bestContent = text; bestContentType = ct;
        if (text.includes("://") && !text.includes("0.0.0.0")) return { ok: true, content: text, contentType: ct, attempts };
      } catch (e) { lastError = e.name === "AbortError" ? "Таймаут запроса" : e.message; }
    }
    if (bestContent) return { ok: true, content: bestContent, contentType: bestContentType, attempts };
    return { ok: false, error: `❌ <b>Не удалось получить подписку</b>\n\nПроверил <b>${attempts}</b> вариантов запроса.\n\nПоследняя ошибка: <code>${escapeHtml(lastError)}</code>\n\n💡 Если ссылка открывается только в Happ, попробуй экспортировать её оттуда или отправить прямую ссылку на подписку.`, attempts };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "Таймаут запроса", attempts: 0 };
    return { ok: false, error: `Ошибка сети: ${e.message}`, attempts: 0 };
  }
}

function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  if (c.includes("<!DOCTYPE") || c.includes("<html") || c.includes("<body") || c.includes("<script")) return "html";
  if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 40) { const decoded = safeBase64(c); if (decoded && decoded.includes("://")) return "base64"; }
  if (c.startsWith("{") || c.startsWith("[")) { try { JSON.parse(c); return "json"; } catch {} }
  if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) return "yaml";
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(l))) return lines.filter(l => !/0\.0\.0\.0|00000000-0000/i.test(l)).length ? "vless-list" : "html";
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