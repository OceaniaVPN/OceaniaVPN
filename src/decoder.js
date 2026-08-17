import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";

const HAPP_UA = "Happ/10.0.0 (Android; 13; Pixel 7) okhttp/4.12.0";
const HAPP_HEADERS = {
  "User-Agent": HAPP_UA,
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Happ-App": "Happ",
  "X-Happ-Platform": "android",
  "Connection": "keep-alive",
};

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

function extractUrlFromHtml(html, originalUrl) {
  const patterns = [
    /<meta[^>]+content=["'][^"']*url=([^"']+)["'][^>]*>/i,
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

async function fetchSubscription(url) {
  try {
    const res = await fetchWithRedirects(url, HAPP_HEADERS);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    
    const text = await res.text();
    const ct = res.headers.get("content-type") || "";
    
    if (ct.includes("text/html") || text.trim().startsWith("<")) {
      const real = extractUrlFromHtml(text, url);
      if (real) return fetchSubscription(real);
      return { ok: false, error: "HTML страница без ссылки на подписку" };
    }
    
    return { ok: true, content: text, contentType: ct };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function detectFormat(content) {
  const c = content.trim();
  if (!c) return "empty";
  
  if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
  
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
  if (lines.length > 0 && lines.some(l => /^[a-z0-9]+:\/\//i.test(l))) {
    return "vless-list";
  }
  
  return "unknown";
}

export async function decodeSubscription(url) {
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
        error: `❓ Неизвестный формат\n\nContent-Type: <code>${result.contentType}</code>\n\nПервые 200 символов:\n<pre>${String(result.content.substring(0, 200)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
      };
  }
}
