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
//  🔥 ИЗВЛЕЧЕНИЕ ВСЕХ URL ИЗ HTML СТРАНИЦЫ
// ═══════════════════════════════════════════

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  
  // 1. happ:// deep-links
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
  
  // 2. data-атрибуты
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m && m[1].startsWith("http")) {
      foundUrls.add(m[1]);
    }
  }
  
  // 3. onclick обработчики
  const onclickMatches = html.match(/onclick=["'][^"']*['"](https?:\/\/[^"'\s]+)['"][^"']*['"]/gi) || [];
  onclickMatches.forEach(m => {
    const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
    if (urlMatch) foundUrls.add(urlMatch[0]);
  });
  
  // 4. JavaScript переменные
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  jsVars.forEach(v => {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m && m[1].startsWith("http")) {
      foundUrls.add(m[1]);
    }
  });
  
  // 5. JSON в HTML
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
  
  // 6. Base64 encoded URL
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
  
  // 7. Стандартные паттерны
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
      if (url.startsWith("http") && url !== originalUrl) {
        foundUrls.add(url);
      }
    }
  }
  
  // 8. Ссылки в <a> тегах
  const linkTags = html.match(/<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi) || [];
  for (const tag of linkTags) {
    const m = tag.match(/href=["'](https?:\/\/[^"']+)["']/i);
    if (m) {
      const href = m[1];
      // Фильтруем только похожие на подписки
      if (href.includes("sub") || href.includes("token") || href.includes("config") || href.includes("uuid")) {
        foundUrls.add(href);
      }
    }
  }
  
  // 9. Любая ссылка с /sub, token=, key=, uuid=
  const anySub = html.match(/["'](https?:\/\/[^"'\s]*\/sub[^"'\s]*)["']/gi) || 
                 html.match(/["'](https?:\/\/[^"'\s]*[?&](?:token|key|uuid|id)=[^"'\s]+)["']/gi) || [];
  for (const s of anySub) {
    const url = s.replace(/["']/g, "").replace(/&amp;/g, "&");
    foundUrls.add(url);
  }
  
  // 10. Простые HTTP ссылки (резерв)
  if (foundUrls.size === 0) {
    const simpleLinks = html.match(/https?:\/\/[^\s"'<>]{20,}/gi) || [];
    for (const link of simpleLinks) {
      if (link.includes("sub") || link.includes("token") || link.includes("config")) {
        foundUrls.add(link);
      }
    }
  }
  
  // Возвращаем массив URL (исключая originalUrl)
  return Array.from(foundUrls).filter(url => url !== originalUrl && url.startsWith("http"));
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
    
    // ШАГ 3: HTML → ищем ВСЕ ссылки
    if (ct.includes("text/html") || text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      const allUrls = extractAllUrlsFromHtml(text, url);
      
      if (allUrls.length > 0) {
        console.log(`[Decoder] Found ${allUrls.length} URLs in HTML:`, allUrls);
        
        // 🔥 Запрашиваем КАЖДУЮ ссылку и объединяем результаты
        const allContents = [];
        for (const subUrl of allUrls) {
          try {
            console.log(`[Decoder] Fetching: ${subUrl}`);
            const subRes = await fetchWithRedirects(subUrl, HAPP_HEADERS);
            if (subRes.ok) {
              const subText = await subRes.text();
              const subCt = subRes.headers.get("content-type") || "";
              
              // Если это снова HTML, рекурсивно ищем дальше
              if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
                const nestedUrls = extractAllUrlsFromHtml(subText, subUrl);
                for (const nestedUrl of nestedUrls) {
                  try {
                    const nestedRes = await fetchWithRedirects(nestedUrl, HAPP_HEADERS);
                    if (nestedRes.ok) {
                      const nestedText = await nestedRes.text();
                      allContents.push(nestedText);
                    }
                  } catch (e) {
                    console.log(`[Decoder] Failed nested URL ${nestedUrl}:`, e.message);
                  }
                }
              } else {
                allContents.push(subText);
              }
            }
          } catch (e) {
            console.log(`[Decoder] Failed URL ${subUrl}:`, e.message);
          }
        }
        
        if (allContents.length > 0) {
          // Объединяем все полученные содержимое
          return { 
            ok: true, 
            content: allContents.join("\n"), 
            contentType: "text/plain" 
          };
        }
      }
      
      return {
        ok: false,
        error: `📄 Получена HTML страница, но ссылки на подписку не найдены\n\n` +
               `Content-Type: ${ct}\n\n` +
               `Первые 500 символов:\n${escapeHtml(text.substring(0, 500))}\n\n` +
               `💡 Совет: открой ссылку в Happ/Hiddify, скопируй подписку и отправь мне текстом`
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
               `Content-Type: ${result.contentType}\n` +
               `Длина: ${result.content.length} символов\n\n` +
               `Первые 300 символов:\n${escapeHtml(result.content.substring(0, 300))}`
      };
  }
      }
