import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";
import { TARGET_USER_AGENTS } from "./useragents.js";

// ══════════════════════════════════════════
//  🚫 ГЛОБАЛЬНЫЙ ЧЕРНЫЙ СПИСОК ДОМЕНОВ
// ═══════════════════════════════════════════
const BLOCKED_DOMAINS = [
  "okeaniavpn.dimastekolnikov1.workers.dev",
  "sub.chkav-vpn.workers.dev"
];

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
//  🔥 ИЗВЛЕЧЕНИЕ URL ИЗ HTML (ПОЛНАЯ ВЕРСИЯ)
// ═══════════════════════════════════════════

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  
  // 🎯 1. happ:// deep-links
  const happLinks = html.match(/happ:\/\/[^"'\s]+/gi) || [];
  for (const link of happLinks) {
    const decoded = decodeURIComponent(link.replace("happ://", ""));
    
    // а) Прямая ссылка
    const direct = decoded.match(/https?:\/\/[^\s]+/gi);
    if (direct) {
      foundUrls.add(direct[0]);
    }
    
    // б) base64 payload
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) { 
      const d = safeBase64(b64[1]);
      if (d) {
        const inner = d.match(/https?:\/\/[^\s"'\\]+/gi) || [];
        inner.forEach(u => foundUrls.add(u));
      }
    }
  }
  
  //  2. data-атрибуты (data-url, data-link, data-subscription)
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
    }
  }
  
  //  3. onclick обработчики
  const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
  for (const m of onclickMatches) {
    const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
    if (urlMatch && !urlMatch[0].includes("0.0.0.0")) {
      foundUrls.add(urlMatch[0]);
    }
  }
  
  // 🎯 4. JavaScript переменные
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsVars) {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
    }
  }
  
  //  5. JSON в HTML
  const jsonInHtml = html.match(/<script[^>]*>\s*(?:var\s+config\s*=)?\s*({[^]*?})\s*<\/script>/gi) || [];
  for (const block of jsonInHtml) {
    try {
      const jsonMatch = block.match(/{[^]*?}/);
      if (jsonMatch) {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj.url) foundUrls.add(obj.url);
        if (obj.subscription) foundUrls.add(obj.subscription);
        if (obj.config) foundUrls.add(obj.config);
        if (obj.link) foundUrls.add(obj.link);
      }
    } catch {}
  }
  
  //  6. Base64 encoded URL
  const b64InHtml = html.match(/["']([A-Za-z0-9+/]{50,}={0,2})["']/g) || [];
  for (const b64 of b64InHtml) {
    try {
      const clean = b64.replace(/["']/g, "");
      const decoded = safeBase64(clean);
      if (decoded && decoded.startsWith("http")) {
        foundUrls.add(decoded);
      }
    } catch {}
  }
  
  //  7. Стандартные паттерны (JS редиректы, meta refresh)
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(["']([^"']+)["']/i,
    /window\.open\(["']([^"']+)["']/i,
    /content=["'][^"']*url=([^"']+)["']/i,
    /href=["'](https?:\/\/[^"']+\.php\?[^"']+)["']/i,
    /action=["'](https?:\/\/[^"']+)["']/i,
  ];
  
  for (const p of patterns) {
    const matches = html.match(p);
    if (matches && matches[1]) {
      let url = matches[1].replace(/&amp;/g, "&");
      if (url.startsWith("happ://")) continue;
      if (url.startsWith("/")) {
        try {
          const base = new URL(originalUrl);
          url = `${base.protocol}//${base.host}${url}`;
        } catch {}
      }
      if (url.startsWith("http") && url !== originalUrl && !url.includes("0.0.0.0")) {
        foundUrls.add(url);
      }
    }
  }
  
  // 🎯 8. Ссылки в <a> тегах
  const linkTags = html.match(/<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi) || [];
  for (const tag of linkTags) {
    const m = tag.match(/href=["'](https?:\/\/[^"']+)["']/i);
    if (m) {
      const href = m[1];
      if (href.includes("sub") || href.includes("token") || href.includes("config") || href.includes("uuid")) {
        if (!href.includes("0.0.0.0")) foundUrls.add(href);
      }
    }
  }
  
  // 🎯 9. Любая ссылка с /sub, token=, key=, uuid=
  const anySub = html.match(/["'](https?:\/\/[^"'\s]*\/sub[^"'\s]*)["']/gi) || 
                 html.match(/["'](https?:\/\/[^"'\s]*[?&](?:token|key|uuid|id)=[^"'\s]+)["']/gi) || [];
  for (const s of anySub) {
    const url = s.replace(/["']/g, "").replace(/&amp;/g, "&");
    if (!url.includes("0.0.0.0")) foundUrls.add(url);
  }
  
  // 🎯 10. Простые HTTP ссылки (резерв)
  if (foundUrls.size === 0) {
    const simpleLinks = html.match(/https?:\/\/[^\s"'<>]{20,}/gi) || [];
    for (const link of simpleLinks) {
      if (link.includes("sub") || link.includes("token") || link.includes("config")) {
        if (!link.includes("0.0.0.0")) foundUrls.add(link);
      }
    }
  }
  
  // Возвращаем массив URL (исключая originalUrl и фейковые)
  return Array.from(foundUrls).filter(url => 
    url !== originalUrl && 
    url.startsWith("http") && 
    !url.includes("0.0.0.0") && 
    !url.includes("00000000-0000")
  );
}

// ═══════════════════════════════════════════
//  🔥 ОСНОВНОЙ FETCH С ПЕРЕБОРОМ UA
// ══════════════════════════════════════════
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
    
    let lastError = "Неизвестная ошибка";

    // 🔥 ПЕРЕБОР 3-х USER-AGENTS
    for (const ua of TARGET_USER_AGENTS) {
      console.log(`[Decoder] Trying UA: ${ua}`);
      
      const headers = { 
        "User-Agent": ua,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
        "Connection": "keep-alive",
      };

      const res = await fetchWithRedirects(actualUrl, headers);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      
      const text = await res.text();
      const ct = res.headers.get("content-type") || "";

      // 🔥 ПРОВЕРКА НА ЗАГЛУШКУ
      if (text.includes("0.0.0.0") || 
          text.includes("00000000-0000") || 
          text.includes("App not supported") || 
          text.includes("not supported")) {
        console.log(`[Decoder] UA "${ua}" вернул заглушку. Next...`);
        lastError = "Сервер вернул заглушку (0.0.0.0)";
        continue;
      }

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
              const subRes = await fetchWithRedirects(subUrl, headers);
              if (subRes.ok) {
                const subText = await subRes.text();
                const subCt = subRes.headers.get("content-type") || "";
                
                // Если снова HTML — пропускаем
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
        
        lastError = "HTML не содержит ссылок на подписку";
        continue;
      } else {
        console.log(`[Decoder] Success with UA: ${ua}`);
        return { ok: true, content: text, contentType: ct };
      }
    }

    return {
      ok: false,
      error: `❌ <b>Не удалось получить подписку</b>\n\n` +
             `Все 3 приложения (Happ, INCY, v2rayTun) получили заглушки.\n\n` +
             ` <b>Решение:</b>\n` +
             `1. Открой ссылку в браузере\n` +
             `2. Нажми <b>"Добавить подписку"</b>\n` +
             `3. Скопируй ссылку (с token=)\n` +
             `4. Отправь её мне`
    };

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
  
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(l))) {
    const fakeCount = lines.filter(l => l.includes("0.0.0.0") || l.includes("00000000-0000")).length;
    if (fakeCount > 0) return "html";
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
    case "html":
      return {
        ok: false,
        error: `❌ <b>Обнаружена HTML-страница или заглушка!</b>\n\n` +
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
