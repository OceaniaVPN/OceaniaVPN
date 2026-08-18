import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";
import { TARGET_USER_AGENTS } from "./useragents.js";

// ═══════════════════════════════════════════
//  🚫 ГЛОБАЛЬНЫЙ ЧЕРНЫЙ СПИСОК ДОМЕНОВ
// ═══════════════════════════════════════════
const BLOCKED_DOMAINS = [
  "okeaniavpn.dimastekolnikov1.workers.dev",
  "sub.chkav-vpn.workers.dev"
];

// ═══════════════════════════════════════════
//  ПРОВЕРКА НА ЗАГЛУШКУ (АГРЕССИВНАЯ)
// ═══════════════════════════════════════════
function isStubResponse(text) {
  if (!text) return true;
  const stubs = [
    "0.0.0.0",
    "00000000-0000",
    "127.0.0.1",
    "localhost",
    "App not supported",
    "not supported",
    "Unsupported app"
  ];
  return stubs.some(s => text.includes(s));
}

// ═══════════════════════════════════════════
//  HTTP С ТАЙМАУТОМ
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

// ═══════════════════════════════════════════
//  HTTP С РЕДИРЕКТАМИ
// ═══════════════════════════════════════════
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
//  ИЗВЛЕЧЕНИЕ РЕДИРЕКТА
// ═══════════════════════════════════════════
function extractRedirectTarget(url) {
  try {
    const urlObj = new URL(url); 
    if (urlObj.pathname.includes("happ-redirect") || urlObj.pathname.includes("redirect")) {
      return urlObj.searchParams.get("url") ||
             urlObj.searchParams.get("sub") ||
             urlObj.searchParams.get("link") ||
             urlObj.searchParams.get("target") || null;
    }
    return urlObj.searchParams.get("url") || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
//  🔥 АГРЕССИВНЫЙ ПОИСК URL ИЗ HTML
// ═══════════════════════════════════════════
function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  
  // 1. happ:// deep-links
  const happLinks = html.match(/happ:\/\/[^"'\s]+/gi) || [];
  for (const link of happLinks) {
    const decoded = decodeURIComponent(link.replace("happ://", ""));
    const direct = decoded.match(/https?:\/\/[^\s]+/gi);
    if (direct && !direct[0].includes("0.0.0.0")) {
      foundUrls.add(direct[0]);
    }
    
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) { 
      const d = safeBase64(b64[1]);
      if (d) {
        (d.match(/https?:\/\/[^\s"'\\]+/gi) || []).forEach(u => {
          if (!u.includes("0.0.0.0")) foundUrls.add(u);
        });
      }
    }
  }
  
  // 2. data-атрибуты кнопок
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
    }
  }

  // 3. Ссылки с token=, uuid=, /sub/, /link/
  const subPatterns = [
    /https?:\/\/[^\s"'<>]+(?:token=|uuid=|client=|api\/v1)[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+\/sub\/[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]+\/link\/[^\s"'<>]+/gi
  ];
  
  for (const p of subPatterns) {
    const matches = html.match(p) || [];
    for (const m of matches) {
      const cleanUrl = m.replace(/&amp;/g, "&").replace(/["']/g, "");
      if (cleanUrl.startsWith("http") && !cleanUrl.includes("0.0.0.0")) {
        foundUrls.add(cleanUrl);
      }
    }
  }

  return Array.from(foundUrls).filter(url => 
    url !== originalUrl && 
    url.startsWith("http") && 
    !url.includes("0.0.0.0")
  );
}

// ═══════════════════════════════════════════
//  🔥 ОСНОВНОЙ FETCH С ПЕРЕБОРОМ ВСЕХ UA
// ═══════════════════════════════════════════
async function fetchSubscription(url) {
  try {
    const lowerUrl = url.toLowerCase();
    if (BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()))) {
      return { ok: false, error: `🚫 <b>Домен заблокирован</b>\n\nОбработка отключена.` };
    }

    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget || url;
    
    console.log(`[Decoder] Target URL: ${actualUrl}`);
    console.log(`[Decoder] Will try ${TARGET_USER_AGENTS.length} User-Agents`);
    
    let lastError = "Неизвестная ошибка";

    // 🔥 ПЕРЕБОР ВСЕХ USER-AGENTS
    for (let i = 0; i < TARGET_USER_AGENTS.length; i++) {
      const ua = TARGET_USER_AGENTS[i];
      console.log(`\n[Decoder] === Attempt ${i + 1}/${TARGET_USER_AGENTS.length} ===`);
      console.log(`[Decoder] UA: ${ua}`);
      
      const headers = { 
        "User-Agent": ua,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
        "Connection": "keep-alive",
        "X-Happ-App": ua.includes("Happ") ? "Happ" : undefined,
        "X-Happ-Platform": ua.includes("Android") ? "android" : (ua.includes("iOS") ? "ios" : "windows")
      };

      try {
        const res = await fetchWithRedirects(actualUrl, headers);
        console.log(`[Decoder] Response status: ${res.status}`);
        
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          console.log(`[Decoder] ❌ HTTP error, trying next UA...`);
          continue;
        }
        
        const text = await res.text();
        const ct = res.headers.get("content-type") || "";
        console.log(`[Decoder] Content-Type: ${ct}`);
        console.log(`[Decoder] Response length: ${text.length} chars`);

        // 🔥 ПРОВЕРКА НА ЗАГЛУШКУ
        if (isStubResponse(text)) {
          console.log(`[Decoder] ⚠️ Stub detected (0.0.0.0 or App not supported), trying next UA...`);
          lastError = "Сервер вернул заглушку";
          continue;
        }

        const isHtml = ct.includes("text/html") || 
                       text.trim().startsWith("<!DOCTYPE") || 
                       text.trim().startsWith("<html") ||
                       text.includes("<body");

        if (isHtml) {
          console.log(`[Decoder] HTML detected, searching for real subscription URL...`);
          const allUrls = extractAllUrlsFromHtml(text, url);
          console.log(`[Decoder] Found ${allUrls.length} URLs in HTML:`, allUrls);
          
          if (allUrls.length > 0) {
            for (const subUrl of allUrls) {
              try {
                console.log(`[Decoder] Fetching sub URL: ${subUrl}`);
                const subRes = await fetchWithRedirects(subUrl, headers);
                if (subRes.ok) {
                  const subText = await subRes.text();
                  const subCt = subRes.headers.get("content-type") || "";
                  
                  if (!isStubResponse(subText) && !subCt.includes("text/html")) {
                    console.log(`[Decoder] ✅ Success with sub URL!`);
                    return { ok: true, content: subText, contentType: subCt };
                  }
                }
              } catch (e) {
                console.log(`[Decoder] Failed sub URL: ${e.message}`);
              }
            }
          }
          
          lastError = "HTML не содержит рабочей подписки";
          console.log(`[Decoder] ⚠️ No working subscription found in HTML, trying next UA...`);
          continue;
        } else {
          console.log(`[Decoder] ✅ SUCCESS! Got non-HTML content`);
          return { ok: true, content: text, contentType: ct };
        }
      } catch (e) {
        console.log(`[Decoder] ⚠️ Error: ${e.message}, trying next UA...`);
        lastError = e.message;
        continue;
      }
    }

    console.log(`\n[Decoder] === ALL UA FAILED ===`);
    
    return {
      ok: false,
      error: `❌ <b>Не удалось получить подписку</b>\n\n` +
             `Бот попробовал все ${TARGET_USER_AGENTS.length} User-Agent, но сервер каждый раз возвращал заглушку "App not supported" или ошибку.\n\n` +
             `Последняя ошибка: <code>${escapeHtml(lastError)}</code>\n\n` +
             `💡 <b>Единственное решение:</b>\n` +
             `1. Открой эту ссылку в браузере на телефоне\n` +
             `2. Нажми кнопку <b>"Добавить подписку"</b>\n` +
             `3. Скопируй ссылку (она должна содержать <code>token=</code>)\n` +
             `4. Отправь эту ссылку мне напрямую`
    };

  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "Таймаут (15 сек)" };
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
  
  if (c.includes("<!DOCTYPE") || c.includes("<html") || c.includes("<body")) return "html";
  
  if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 40) {
    const decoded = safeBase64(c);
    if (decoded && decoded.includes("://")) return "base64";
  }
  
  if (c.startsWith("{") || c.startsWith("[")) {
    try { JSON.parse(c); return "json"; } catch {}
  }
  
  if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) {
    return "yaml";
  }
  
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(l))) {
    const fakeCount = lines.filter(l => l.includes("0.0.0.0") || l.includes("00000000-0000")).length;
    if (fakeCount > 0) return "html";
    return "vless-list";
  }
  
  return "unknown";
}

// ═══════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ
// ═══════════════════════════════════════════
export async function decodeSubscription(url) {
  const result = await fetchSubscription(url);
  
  if (!result.ok) {
    return { ok: false, error: `Ошибка: ${result.error}` };
  }
  
  // 🔥 ФИНАЛЬНАЯ ПРОВЕРКА: даже если fetch прошел, проверяем контент на заглушку перед парсингом
  if (isStubResponse(result.content)) {
    return {
      ok: false,
      error: `❌ <b>Обнаружена заглушка!</b>\n\n` +
             `Сервер вернул фейковые ключи (0.0.0.0) или "App not supported".\n\n` +
             `💡 Открой ссылку в браузере → нажми "Добавить подписку" → скопируй прямую ссылку`
    };
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
    case "html":
      return {
        ok: false,
        error: `❌ <b>HTML-страница или заглушка!</b>\n\n` +
               `Обнаружены фейковые ключи (0.0.0.0).\n\n` +
               `💡 Открой в браузере → нажми "Добавить подписку" → скопируй ссылку`
      };
    default:
      return {
        ok: false,
        error: `❓ Неизвестный формат\n\n` +
               `Content-Type: ${result.contentType}\n` +
               `Длина: ${result.content.length}\n\n` +
               `Первые 300 символов:\n${escapeHtml(result.content.substring(0, 300))}`
      };
  }
}
