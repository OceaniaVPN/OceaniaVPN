import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";

// ═══════════════════════════════════════════
//  🚫 ГЛОБАЛЬНЫЙ ЧЕРНЫЙ СПИСОК ДОМЕНОВ
// ═══════════════════════════════════════════
const BLOCKED_DOMAINS = [
  "okeaniavpn.dimastekolnikov1.workers.dev",
  "sub.chkav-vpn.workers.dev"
];

// ═══════════════════════════════════════════
//  🎭 ПУЛ РАНДОМНЫХ USER-AGENT
// ═══════════════════════════════════════════
const USER_AGENTS_POOL = [
  "Happ/10.0.0 (Android 14; Poco X6 Pro 5G) okhttp/4.12.0",
  "Happ/10.0.0 (Android 14; Xiaomi 13 Pro) okhttp/4.12.0",
  "Happ/10.0.0 (Android 14; OnePlus 11 Pro) okhttp/4.12.0",
  "Happ/10.0.0 (iOS 17.4; iPhone16,2) okhttp/4.12.0",
  "Happ/10.0.0 (iOS 17.4; iPhone16,4) okhttp/4.12.0",
  "v2rayNG/1.8.20 (Android 14; Poco X6 Pro 5G)",
  "Hiddify/5.0.0 (Android 14; Xiaomi 13 Pro)",
  "INCY/2.1.0 (Android 14; OnePlus 11 Pro)",
  "INCY/2.1.0 (Windows NT 10.0; Win64; x64)",
  "INCY/2.1.0 (Windows NT 11.0; Win64; x64)",
  "INCY/2.1.0 (Windows NT 6.1; Win64; x64)",
  "Hiddify/5.0.0 (Windows NT 10.0; Win64; x64)",
  "Hiddify/5.0.0 (X11; Linux x86_64)",
  "INCY/2.1.0 (X11; Linux x86_64)"
];

function getRandomUA() {
  return USER_AGENTS_POOL[Math.floor(Math.random() * USER_AGENTS_POOL.length)];
}

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

async function fetchWithRedirects(url, max = 5) {
  let currentUrl = url;
  
  for (let i = 0; i < max; i++) {
    const dynamicHeaders = { 
      "User-Agent": getRandomUA(),
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
      "Connection": "keep-alive",
    };

    const res = await fetchWithTimeout(
      currentUrl,
      { method: "GET", headers: dynamicHeaders, redirect: "manual" },
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
  
  const dynamicHeaders = { "User-Agent": getRandomUA(), "Accept": "*/*" };
  return await fetchWithTimeout(currentUrl, { method: "GET", headers: dynamicHeaders }, 15000);
}

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
//  🔥 АГРЕССИВНЫЙ ПОИСК URL (БЕЗ ЗАГЛУШЕК!)
// ═══════════════════════════════════════════

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  
  // 🎯 1. ПРИОРИТЕТ: Ищем ТОЛЬКО реальные ссылки на подписки (token, uuid, sub, api/v1, link/)
  const subPatterns = [
    /https?:\/\/[^\s"'<>]+(?:subscribe|token=|uuid=|client=|api\/v1)[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+\/link\/[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]+\/sub\/[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]+[?&](?:token|uuid|id|key)=[a-f0-9-]+[^\s"'<>]*/gi
  ];
  
  for (const p of subPatterns) {
    const matches = html.match(p) || [];
    for (const m of matches) {
      const cleanUrl = m.replace(/&amp;/g, "&").replace(/["']/g, "");
      // 🔥 АГРЕССИВНАЯ ФИЛЬТРАЦИЯ: отбрасываем всё с 0.0.0.0
      if (cleanUrl.startsWith("http") && 
          !cleanUrl.includes("0.0.0.0") && 
          !cleanUrl.includes("00000000-0000") &&
          !cleanUrl.includes("127.0.0.1") &&
          !cleanUrl.includes("localhost")) {
        foundUrls.add(cleanUrl);
      }
    }
  }
  
  // 🎯 2. data-атрибуты кнопок (data-url, data-link, data-subscription)
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && 
        !m[1].includes("0.0.0.0") && 
        !m[1].includes("00000000-0000")) {
      foundUrls.add(m[1]);
    }
  }
  
  //  3. onclick обработчики кнопок
  const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
  for (const m of onclickMatches) {
    const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
    if (urlMatch && 
        !urlMatch[0].includes("0.0.0.0") && 
        !urlMatch[0].includes("00000000-0000")) {
      foundUrls.add(urlMatch[0]);
    }
  }
  
  // 🎯 4. happ:// deep-links (извлекаем реальный URL)
  const happLinks = html.match(/happ:\/\/[^"'\s]+/gi) || [];
  for (const link of happLinks) {
    const decoded = decodeURIComponent(link.replace("happ://", ""));
    const direct = decoded.match(/https?:\/\/[^\s]+/gi);
    if (direct && 
        !direct[0].includes("0.0.0.0") && 
        !direct[0].includes("00000000-0000")) {
      foundUrls.add(direct[0]);
    }
    
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) { 
      const d = safeBase64(b64[1]);
      if (d) {
        const inner = d.match(/https?:\/\/[^\s"'\\]+/gi) || [];
        inner.forEach(u => {
          if (!u.includes("0.0.0.0") && !u.includes("00000000-0000")) {
            foundUrls.add(u);
          }
        });
      }
    }
  }
  
  // 🎯 5. JavaScript переменные
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsVars) {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && 
        !m[1].includes("0.0.0.0") && 
        !m[1].includes("00000000-0000")) {
      foundUrls.add(m[1]);
    }
  }

  // 🔥 ФИНАЛЬНАЯ ПРОВЕРКА: возвращаем только URL с token= или /sub/
  const validUrls = Array.from(foundUrls).filter(url => 
    url !== originalUrl && 
    url.startsWith("http") && 
    (url.includes("token=") || url.includes("/sub") || url.includes("uuid="))
  );
  
  return validUrls;
}

// ═══════════════════════════════════════════
//  ОСНОВНОЙ FETCH ПОДПИСКИ
// ═══════════════════════════════════════════

async function fetchSubscription(url) {
  try {
    // 🚫 ШАГ 0: ГЛОБАЛЬНАЯ ПРОВЕРКА НА ЗАБЛОКИРОВАННЫЕ ДОМЕНЫ
    const lowerUrl = url.toLowerCase();
    const isBlocked = BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()));
    if (isBlocked) {
      return { 
        ok: false, 
        error: `🚫 <b>Домен заблокирован</b>\n\nОбработка запросов к этому домену глобально отключена.` 
      };
    }

    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget || url;
    
    if (redirectTarget) {
      console.log(`[Decoder] Redirect: ${url} -> ${redirectTarget}`);
    }
    
    const res = await fetchWithRedirects(actualUrl);
    
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    
    const isHtml = ct.includes("text/html") || 
                   text.trim().startsWith("<!DOCTYPE") || 
                   text.trim().startsWith("<html") ||
                   text.includes("<body") ||
                   text.includes("<script");
    
    if (isHtml) {
      const allUrls = extractAllUrlsFromHtml(text, url);
      
      console.log(`[Decoder] Found URLs in HTML:`, allUrls);
      
      if (allUrls.length > 0) {
        const allContents = [];
        for (const subUrl of allUrls) {
          try {
            console.log(`[Decoder] Fetching real sub: ${subUrl}`);
            const subRes = await fetchWithRedirects(subUrl);
            if (subRes.ok) {
              const subText = await subRes.text();
              const subCt = subRes.headers.get("content-type") || "";
              
              // 🔥 Если снова HTML — пропускаем (это не подписка!)
              if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
                console.log(`[Decoder] Skipping HTML response for ${subUrl}`);
                continue;
              }
              
              allContents.push(subText);
            }
          } catch (e) {
            console.log(`[Decoder] Failed sub URL ${subUrl}:`, e.message);
          }
        }
        
        if (allContents.length > 0) {
          return { ok: true, content: allContents.join("\n"), contentType: "text/plain" };
        }
      }
      
      return {
        ok: false,
        error: `📄 <b>Получена HTML страница HatVPN</b>\n\n` +
               `❌ <b>Реальная ссылка на подписку НЕ найдена!</b>\n\n` +
               `💡 <b>Что делать:</b>\n` +
               `1. Открой эту ссылку в браузере\n` +
               `2. Нажми кнопку <b>"Добавить подписку"</b>\n` +
               `3. Скопируй ссылку (она должна содержать <code>token=</code>)\n` +
               `4. Отправь эту ссылку мне\n\n` +
               `<i>Бот НЕ будет декодировать заглушки vless://0.0.0.0!</i>`
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
//  ДЕТЕКТОР ФОРМАТА (АГРЕССИВНЫЙ)
// ═══════════════════════════════════════════

function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  
  if (c.includes("<!DOCTYPE") || c.includes("<html") || c.includes("<body") || c.includes("<script")) {
    return "html";
  }
  
  if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 40) {
    const decoded = safeBase64(c);
    if (decoded && decoded.includes("://")) return "base64";
  }
  
  if (c.startsWith("{") || c.startsWith("[")) {
    try {
      JSON.parse(c);
      return "json";
    } catch {}
  }
  
  if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) {
    return "yaml";
  }
  
  // vless/vmess список
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(l))) {
    // 🔥 АГРЕССИВНАЯ ПРОВЕРКА: если есть заглушки — считаем это HTML!
    const fakeCount = lines.filter(l => 
      l.includes("0.0.0.0") || 
      l.includes("00000000-0000") ||
      l.includes("127.0.0.1")
    ).length;
    
    if (fakeCount > 0) {
      console.log(`[Decoder] Detected ${fakeCount} fake proxies, rejecting as HTML`);
      return "html";
    }
    
    return "vless-list";
  }
  
  return "unknown";
}

// ═══════════════════════════════════════════
//  ГЛАВНАЯ ФУНКЦИЯ ДЕКОДЕРА
// ══════════════════════════════════════════

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
    case "html":
      return {
        ok: false,
        error: `❌ <b>Обнаружена HTML-страница или заглушки!</b>\n\n` +
               `Бот обнаружил фейковые ключи (0.0.0.0) вместо реальной подписки.\n\n` +
               `💡 <b>Инструкция:</b>\n` +
               `1. Открой ссылку в браузере\n` +
               `2. Нажми <b>"Добавить подписку"</b>\n` +
               `3. Скопируй ссылку (с token=)\n` +
               `4. Отправь её мне`
      };
    default:
      return {
        ok: false,
        error: `❓ Неизвестный формат\n\n` +
               `Content-Type: ${result.contentType}\n` +
               `Длина: ${result.content.length} символов\n\n` +
               `Первые 300 символов:\n${escapeHtml(result.content.substring(0, 300))}`
      };
  }
      }
