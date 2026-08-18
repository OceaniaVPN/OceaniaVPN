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
//  🔥 УМНЫЙ ПОИСК ВСЕХ URL ИЗ HTML (БЕЗ ФЕЙКОВ)
// ═══════════════════════════════════════════

function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();
  
  // 🎯 1. ПРИОРИТЕТ: Ищем явные ссылки на подписки (token, subscribe, api/v1, link/)
  const subPatterns = [
    /https?:\/\/[^\s"'<>]+(?:subscribe|token|uuid|client|api\/v1)[^\s"'<>]*/gi,
    /https?:\/\/[^\s"'<>]+\/link\/[^\s"'<>]+/gi,
    /https?:\/\/[^\s"'<>]+\/sub\/[^\s"'<>]+/gi
  ];
  
  for (const p of subPatterns) {
    const matches = html.match(p) || [];
    for (const m of matches) {
      const cleanUrl = m.replace(/&amp;/g, "&").replace(/["']/g, "");
      if (cleanUrl.startsWith("http") && !cleanUrl.includes("0.0.0.0") && !cleanUrl.includes("00000000-0000")) {
        foundUrls.add(cleanUrl);
      }
    }
  }
  
  // 🎯 2. data-атрибуты (data-url, data-link, data-clipboard-text)
  const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
  for (const attr of dataAttrs) {
    const m = attr.match(/=["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
    }
  }
  
  // 🎯 3. onclick="copy('URL')" или подобные JS функции
  const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
  for (const m of onclickMatches) {
    const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
    if (urlMatch && !urlMatch[0].includes("0.0.0.0")) {
      foundUrls.add(urlMatch[0]);
    }
  }
  
  // 🎯 4. happ:// deep-links (извлекаем реальный URL из них)
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
        const inner = d.match(/https?:\/\/[^\s"'\\]+/gi) || [];
        inner.forEach(u => {
          if (!u.includes("0.0.0.0")) foundUrls.add(u);
        });
      }
    }
  }
  
  // 🎯 5. JavaScript переменные
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsVars) {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
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
//  ОСНОВНОЙ FETCH ПОДПИСКИ
// ═══════════════════════════════════════════

async function fetchSubscription(url) {
  try {
    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget || url;
    
    if (redirectTarget) {
      console.log(`[Decoder] Redirect: ${url} -> ${redirectTarget}`);
    }
    
    const res = await fetchWithRedirects(actualUrl, HAPP_HEADERS);
    
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    }
    
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    
    // 🔥 ПРОВЕРКА НА HTML: если это HTML, ищем реальные ссылки, а не парсим как vless-list!
    const isHtml = ct.includes("text/html") || 
                   text.trim().startsWith("<!DOCTYPE") || 
                   text.trim().startsWith("<html") ||
                   text.includes("<body") ||
                   text.includes("<script");
    
    if (isHtml) {
      const allUrls = extractAllUrlsFromHtml(text, url);
      
      if (allUrls.length > 0) {
        console.log(`[Decoder] Found ${allUrls.length} real URLs in HTML:`, allUrls);
        
        const allContents = [];
        for (const subUrl of allUrls) {
          try {
            console.log(`[Decoder] Fetching real sub: ${subUrl}`);
            const subRes = await fetchWithRedirects(subUrl, HAPP_HEADERS);
            if (subRes.ok) {
              const subText = await subRes.text();
              const subCt = subRes.headers.get("content-type") || "";
              
              // Если снова HTML (редирект на страницу), ищем глубже
              if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
                const nestedUrls = extractAllUrlsFromHtml(subText, subUrl);
                for (const nestedUrl of nestedUrls) {
                  try {
                    const nestedRes = await fetchWithRedirects(nestedUrl, HAPP_HEADERS);
                    if (nestedRes.ok) {
                      allContents.push(await nestedRes.text());
                    }
                  } catch (e) {
                    console.log(`[Decoder] Failed nested: ${nestedUrl}`);
                  }
                }
              } else {
                allContents.push(subText);
              }
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
        error: `📄 Получена HTML страница, но реальная ссылка на подписку не найдена.\n\n` +
               `💡 Совет: открой эту ссылку в браузере, нажми "Скопировать ссылку" и отправь мне именно её.`
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
//  ДЕТЕКТОР ФОРМАТА (УСИЛЕННЫЙ)
// ═══════════════════════════════════════════

function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  
  // 🔥 БЛОКИРОВКА: если это явно HTML, не пытаемся парсить как vless-list или base64!
  if (c.includes("<!DOCTYPE") || c.includes("<html") || c.includes("<body") || c.includes("<script")) {
    return "html";
  }
  
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
  
  // vless/vmess список (только если нет HTML-тегов и это реальные ссылки)
  const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss| hysteria|tuic|wireguard):\/\//i.test(l))) {
    // Дополнительная проверка: если большинство строк содержат "0.0.0.0", это фейк
    const fakeCount = lines.filter(l => l.includes("0.0.0.0") || l.includes("00000000-0000")).length;
    if (fakeCount > lines.length / 2) {
      return "html"; // Принудительно считаем HTML-ом, чтобы выдать ошибку с подсказкой
    }
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
        error: `❌ <b>Обнаружена HTML-страница с инструкциями, а не сама подписка.</b>\n\n` +
               `Провайдер спрятал реальную ссылку. Попробуйте:\n` +
               `1. Открыть эту ссылку в браузере.\n` +
               `2. Нажать кнопку "Скопировать ссылку" или "Subscribe".\n` +
               `3. Отправить мне <b>ту ссылку, которая скопировалась</b> (она обычно содержит <code>token=</code> или <code>/sub/</code>).`
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
