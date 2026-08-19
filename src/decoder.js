import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";
import { TARGET_USER_AGENTS } from "./useragents.js";

// ═══════════════════════════════════════════
//   ГЛОБАЛЬНЫЙ ЧЕРНЫЙ СПИСОК ДОМЕНОВ
// ═══════════════════════════════════════════
const BLOCKED_DOMAINS = [
  "okeaniavpn.dimastekolnikov1.workers.dev",
  "sub.chkav-vpn.workers.dev"
];

// ═══════════════════════════════════════════
//  🛡 ПРОВЕРКА НА ЗАГЛУШКУ (АГРЕССИВНАЯ)
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
    "Unsupported app",
    "invalid subscription",
    "subscription not found"
  ];
  return stubs.some(s => text.includes(s));
}

// ═══════════════════════════════════════════
//  ⏱ HTTP С ТАЙМАУТОМ
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
//  🔄 HTTP С РЕДИРЕКТАМИ
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
//  🎯 ИЗВЛЕЧЕНИЕ РЕДИРЕКТА
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
//  🔥 АГРЕССИВНЫЙ ПОИСК URL ИЗ HTML (ИСПРАВЛЕННАЯ ВЕРСИЯ)
// ═══════════════════════════════════════════
function extractAllUrlsFromHtml(html, originalUrl) {
  const foundUrls = new Set();

  // 1. happ:// deep-links
  const happLinks = html.match(/happ:\/\/[^\s"'<>]+/gi) || [];
  for (const link of happLinks) {
    const decoded = decodeURIComponent(link.replace("happ://", ""));
    const direct = decoded.match(/https?:\/\/[^\s"'<>]+/gi);
    if (direct && !direct[0].includes("0.0.0.0")) {
      foundUrls.add(direct[0]);
    }
    const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
    if (b64) {
      const d = safeBase64(b64[1]);
      if (d) {
        (d.match(/https?:\/\/[^\s"'<>]+/gi) || []).forEach(u => {
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

  // 3. onclick обработчики
  const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
  for (const m of onclickMatches) {
    const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
    if (urlMatch && !urlMatch[0].includes("0.0.0.0")) {
      foundUrls.add(urlMatch[0]);
    }
  }

  // 4. JavaScript переменные
  const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
  for (const v of jsVars) {
    const m = v.match(/=\s*["']([^"']+)["']/);
    if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
      foundUrls.add(m[1]);
    }
  }

  // 5. JSON в HTML
  const jsonInHtml = html.match(/<script[^>]*>\s*(?:var\s+config\s*=)?\s*({[\s\S]*?})\s*<\/script>/gi) || [];
  for (const block of jsonInHtml) {
    try {
      const jsonMatch = block.match(/{[\s\S]*?}/);
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
  const b64InHtml = html.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const b64 of b64InHtml) {
    try {
      const decoded = safeBase64(b64);
      if (decoded && decoded.startsWith("http")) {
        foundUrls.add(decoded);
      }
    } catch {}
  }

  // 7. Стандартные паттерны (JS редиректы, meta refresh) — ИСПРАВЛЕНО: добавлены [] и группы захвата
  const patterns = [
    /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /window\.location\.replace\(["']([^"']+)["']\)/i,
    /window\.open\(["']([^"']+)["']\)/i,
    /content=["'][^"']*url=([^"']+)["']/i,
    /href=["']([^"']+)["']/i,
    /action=["']([^"']+)["']/i,
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

  // 8. Ссылки в <a> тегах
  const linkTags = html.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi) || [];
  for (const tag of linkTags) {
    const m = tag.match(/href=["']([^"']+)["']/i);
    if (m) {
      const href = m[1];
      if ((href.includes("sub") || href.includes("token") || href.includes("config") || href.includes("uuid")) && !href.includes("0.0.0.0")) {
        foundUrls.add(href);
      }
    }
  }

  // 9. Любая ссылка с /sub, token=, key=, uuid=
  const anySub = html.match(/https?:\/\/[^\s"'<>]*?(?:sub|token=|key=|uuid=)[^\s"'<>]*/gi) || [];
  for (const s of anySub) {
    const url = s.replace(/["']/g, "").replace(/&amp;/g, "&");
    if (!url.includes("0.0.0.0")) foundUrls.add(url);
  }

  // 10. Простые HTTP ссылки (резерв)
  if (foundUrls.size === 0) {
    const simpleLinks = html.match(/https?:\/\/[^\s"'<>]{20,}/gi) || [];
    for (const link of simpleLinks) {
      if ((link.includes("sub") || link.includes("token") || link.includes("config")) && !link.includes("0.0.0.0")) {
        foundUrls.add(link);
      }
    }
  }

  return Array.from(foundUrls).filter(url =>
    url !== originalUrl &&
    url.startsWith("http") &&
    !url.includes("0.0.0.0") &&
    !url.includes("00000000-0000")
  );
}

// ═══════════════════════════════════════════
//  🔥 ОСНОВНОЙ FETCH С ПЕРЕБОРОМ ВСЕХ UA
// ═══════════════════════════════════════════
async function fetchSubscription(url) {
  try {
    const lowerUrl = url.toLowerCase();
    if (BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()))) {
      return { ok: false, error: "🚫 Домен заблокирован", attempts: 0 };
    }

    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget || url;
    
    let lastError = "Неизвестная ошибка";
    let attempts = 0;

    for (let i = 0; i < TARGET_USER_AGENTS.length; i++) {
      attempts = i + 1;
      const ua = TARGET_USER_AGENTS[i];
      
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
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        
        const text = await res.text();
        const ct = res.headers.get("content-type") || "";

        if (isStubResponse(text)) {
          lastError = "Сервер вернул заглушку (0.0.0.0 / App not supported)";
          continue;
        }

        const isHtml = ct.includes("text/html") || 
                       text.trim().startsWith("<!DOCTYPE") || 
                       text.trim().startsWith("<html") ||
                       text.includes("<body") ||
                       text.includes("<script");

        if (isHtml) {
          const allUrls = extractAllUrlsFromHtml(text, url);
          if (allUrls.length > 0) {
            const allContents = [];
            for (const subUrl of allUrls) {
              try {
                const subRes = await fetchWithRedirects(subUrl, headers);
                if (subRes.ok) {
                  const subText = await subRes.text();
                  const subCt = subRes.headers.get("content-type") || "";
                  
                  if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
                    const nestedUrls = extractAllUrlsFromHtml(subText, subUrl);
                    for (const nestedUrl of nestedUrls) {
                      try {
                        const nestedRes = await fetchWithRedirects(nestedUrl, headers);
                        if (nestedRes.ok) {
                          const nestedText = await nestedRes.text();
                          if (!isStubResponse(nestedText)) {
                            allContents.push(nestedText);
                          }
                        }
                      } catch {}
                    }
                  } else {
                    if (!isStubResponse(subText)) {
                      allContents.push(subText);
                    }
                  }
                }
              } catch {}
            }
            
            if (allContents.length > 0) {
              return { ok: true, content: allContents.join("\n"), contentType: "text/plain", attempts };
            }
          }
          lastError = "HTML не содержит рабочей подписки";
          continue;
        } else {
          return { ok: true, content: text, contentType: ct, attempts };
        }
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }

    return {
      ok: false,
      error: `❌ <b>Не удалось получить подписку</b>\n\nБот попробовал <b>${attempts}</b> User-Agent'ов, но сервер каждый раз возвращал заглушку или ошибку.\n\nПоследняя ошибка: <code>${escapeHtml(lastError)}</code>\n\n💡 <b>Единственное решение:</b>\n1. Открой эту ссылку в браузере на телефоне\n2. Нажми кнопку <b>"Добавить подписку"</b>\n3. Скопируй прямую ссылку (она должна содержать <code>token=</code>)\n4. Отправь эту ссылку мне напрямую`,
      attempts
    };

  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "Таймаут (15 сек)", attempts: 0 };
    return { ok: false, error: `Ошибка сети: ${e.message}`, attempts: 0 };
  }
}

// ═══════════════════════════════════════════
//  🕵️ ДЕТЕКТОР ФОРМАТА
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
//  🚀 ГЛАВНАЯ ФУНКЦИЯ ДЕКОДЕРА
// ═══════════════════════════════════════════
export async function decodeSubscription(url) {
  const result = await fetchSubscription(url);
  
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts || 0 };
  }
  
  if (isStubResponse(result.content)) {
    return {
      ok: false,
      error: `❌ <b>Обнаружена заглушка!</b>\n\nСервер вернул фейковые ключи (0.0.0.0) или "App not supported".\n\n💡 Открой ссылку в браузере → нажми "Добавить подписку" → скопируй прямую ссылку`,
      attempts: result.attempts || 0
    };
  }
  
  const format = detectFormat(result.content);
  
  let parseResult;
  switch (format) {
    case "vless-list": parseResult = parseVlessList(result.content); break;
    case "base64": parseResult = parseBase64(result.content); break;
    case "yaml": parseResult = parseYaml(result.content); break;
    case "json": parseResult = parseJson(result.content); break;
    case "crypt": parseResult = parseCrypt(result.content); break;
    case "empty": parseResult = { ok: false, error: "Пустая подписка" }; break;
    case "html":
      parseResult = {
        ok: false,
        error: `❌ <b>HTML-страница или заглушка!</b>\n\nОбнаружены фейковые ключи (0.0.0.0).\n\n💡 Открой в браузере → нажми "Добавить подписку" → скопируй ссылку`
      };
      break;
    default:
      parseResult = {
        ok: false,
        error: `❓ Неизвестный формат\n\nContent-Type: ${result.contentType}\nДлина: ${result.content.length}\n\nПервые 300 символов:\n${escapeHtml(result.content.substring(0, 300))}`
      };
  }

  parseResult.attempts = result.attempts;
  return parseResult;
      }
