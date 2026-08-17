import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";

// ═══════════════════════════════════════════
//  МАСКИРОВКА ПОД HAPP
// ═══════════════════════════════════════════

const HAPP_UA = "Happ/10.0.0 (Android; 13; Pixel 7) okhttp/4.12.0";
const HAPP_HEADERS = {
  "User-Agent": HAPP_UA,
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Happ-App": "Happ",
  "X-Happ-Platform": "android",
  "X-Happ-Version": "10.0.0",
  "Connection": "keep-alive",
};

// ═══════════════════════════════════════════
//  HTTP С ТАЙМАУТОМ И РЕДИРЕКТАМИ
// ═══════════════════════════════════════════

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRedirects(url, headers, max = 5) {
  let currentUrl = url;
  
  for (let i = 0; i < max; i++) {
    const res = await fetchWithTimeout(
      currentUrl,
      { method: "GET", headers, redirect: "manual" },
      15000
    );
    
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      
      currentUrl = loc.startsWith("/")
        ? `${new URL(currentUrl).protocol}//${new URL(currentUrl).host}${loc}`
        : loc;
      
      const redirectTarget = extractRedirectTarget(currentUrl);
      if (redirectTarget) currentUrl = redirectTarget;
      
      continue;
    }
    
    return res;
  }
  
  return await fetchWithTimeout(currentUrl, { method: "GET", headers }, 15000);
}

// ═══════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ РЕАЛЬНОЙ ССЫЛКИ ИЗ URL
// ═══════════════════════════════════════════

function extractRedirectTarget(url) {
  try {
    const urlObj = new URL(url);
    
    if (urlObj.pathname.includes("happ-redirect") || urlObj.pathname.includes("redirect")) {
      const target = urlObj.searchParams.get("url") ||
                     urlObj.searchParams.get("sub") ||
                     urlObj.searchParams.get("link") ||
                     urlObj.searchParams.get("target");
      if (target) return target;
    }
    
    if (urlObj.searchParams.get("url")) {
      return urlObj.searchParams.get("url");
    }
    
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
//  ИЗВЛЕЧЕНИЕ URL ИЗ HTML СТРАНИЦЫ
// ═══════════════════════════════════════════

function extractUrlFromHtml(html, originalUrl) {
  // 🎯 1. happ:// deep-links (кнопка «Нажмите здесь»)
  const happLinks = html.match(/happ:\/\/[^"'\s<>\\]+/gi) || [];
  for (const link of happLinks) {
    let decoded = link;
    try { decoded = decodeURIComponent(link); } catch {}
    
    // а) внутри deep-link зашита https:// ссылка
    const direct = decoded.match(/https?:\/\/[^\s"'<>]+/i);
    if (direct) return direct[0];
    
    // б) base64 payload после happ://add/
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) {
      const d = safeBase64(b64[1]);
      if (d) {
        const inner = d.match(/https?:\/\/[^\s"'<>]+/i);
        if (inner) return inner[0];
        if (d.includes("://")) return d;
      }
    }
  }
  
  // 🎯 2. URL-кодированные ссылки (%3A%2F%2F...)
  const encoded = html.match(/https?%3A%2F%2F[^"'\s<>\\]+/gi) || [];
  for (const enc of encoded) {
    try {
      const dec = decodeURIComponent(enc);
      if (dec.startsWith("http") && dec !== originalUrl) return dec;
    } catch {}
  }
  
  // 🎯 3. Стандартные паттерны (JS редиректы, meta refresh)
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(["']([^"']+)["']/i,
    /window\.open\(["']([^"']+)["']/i,
    /content=["'][^"']*url=([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      let url = m[1].replace(/&amp;/g, "&");
      if (url.startsWith("happ://")) continue;
      if (url.startsWith("/")) {
        try {
          const base = new URL(originalUrl);
          url = `${base.protocol}//${base.host}${url}`;
        } catch {}
      }
      if (url.startsWith("http") && url !== originalUrl) return url;
    }
  }
  
  // 🎯 4. Любая ссылка с token= или /sub в HTML
  const anySub = html.match(/["'](https?:\/\/[^"'\s<>]*(?:token=|\/sub)[^"'\s<>]*)["']/i);
  if (anySub) {
    return anySub[1].replace(/&amp;/g, "&");
  }
  
  return null;
}

// ═══════════════════════════════════════════
//  ОСНОВНОЙ FETCH ПОДПИСКИ
// ═══════════════════════════════════════════

async function fetchSubscription(url) {
  try {
    // ШАГ 1: happ-redirect?url=... → достаём настоящую ссылку
    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget || url;
    
    if (redirectTarget) {
      console.log(`[Decoder] Redirect: ${url} -> ${redirectTarget}`);
    }
    
    // ШАГ 2: запрос с Happ UA
    const res = await fetchWithRedirects(actualUrl, HAPP_HEADERS);
    
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    
    // ШАГ 3: HTML → ищем реальную ссылку
    if (ct.includes("text/html") || text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      const realUrl = extractUrlFromHtml(text, actualUrl);
      
      if (realUrl && realUrl !== actualUrl) {
        console.log(`[Decoder] HTML redirect to: ${realUrl}`);
        return fetchSubscription(realUrl);
      }
      
      return {
        ok: false,
        error: `HTML страница без ссылки на подписку\n\n` +
               `<b>Content-Type:</b> <code>${ct}</code>\n\n` +
               `<b>Первые 300 символов:</b>\n<pre>${escapeHtml(text.substring(0, 300))}</pre>\n\n` +
               `💡 <b>Совет:</b> открой ссылку в Happ, скопируй подписку и отправь мне текстом`
      };
    }
    
    return { ok: true, content: text, contentType: ct };
  } catch (e) {
    if (e.name === "AbortError") {
      return { ok: false, error: "Таймаут запроса (15 сек)" };
    }
    return { ok: false, error: `Ошибка сети: ${e.message}` };
  }
}

// ═══════════════════════════════════════════
//  ДЕТЕКТОР ФОРМАТА
// ═══════════════════════════════════════════

function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  
  // Base64
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
  
  // YAML
  if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) {
    return "yaml";
  }
  
  // vless/vmess список
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^[a-z0-9]+:\/\//i.test(l))) {
    return "vless-list";
  }
  
  return "unknown";
}

// ═══════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ ДЕКОДЕРА
// ═══════════════════════════════════════════

export async function decodeSubscription(url) {
  const result = await fetchSubscription(url);
  
  if (!result.ok) {
    return { ok: false, error: `Ошибка получения: ${result.error}` };
  }
  
  const format = detectFormat(result.content);
  console.log(`[Decoder] Format: ${format}, length: ${result.content.length}`);
  
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
        error: `❓ Неизвестный формат\n\n` +
               `<b>Content-Type:</b> <code>${result.contentType}</code>\n` +
               `<b>Длина:</b> ${result.content.length} символов\n\n` +
               `<b>Первые 300 символов:</b>\n<pre>${escapeHtml(result.content.substring(0, 300))}</pre>`
      };
  }
    }
