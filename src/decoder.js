import {
  parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
} from "./parsers.js";
import { escapeHtml } from "./config.js";
import { DECODER_USER_AGENT } from "./useragents.js";
import { fetchWithRedirects } from "./subscription-http.js";
import { connect } from "cloudflare:sockets";

const BLOCKED_DOMAINS = [
  "sub.chkav-vpn.workers.dev",
  "steklovpn.dimastekolnikov13.workers.dev",
  "broxvpn.apruxdomain.online",
];


function normalizeText(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .trim();
}

function safeHost(value) {
  try { return new URL(String(value || "")).hostname || null; }
  catch { return null; }
}

function safeRequestTarget(value) {
  try {
    const url = new URL(String(value || ""));
    const path = (url.pathname || "/").split("/").map(segment =>
      segment.length > 48 ? "[redacted]" : segment
    ).join("/");
    return {
      protocol: url.protocol.replace(/:$/, ""),
      host: url.hostname,
      path,
      target: url.protocol + "//" + url.host + path,
    };
  } catch {
    return { protocol: null, host: safeHost(value), path: null, target: null };
  }
}

function httpStatusName(status) {
  return ({
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
    410: "Gone", 425: "Too Early", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 504: "Gateway Timeout",
  })[Number(status)] || "HTTP Error";
}

function describeHttpFailure(response, requestUrl, attempts, stage) {
  const status = Number(response && response.status) || 0;
  const endpoint = safeRequestTarget((response && response.url) || requestUrl);
  const statusName = httpStatusName(status);
  let explanation = "Источник отклонил HTTP-запрос.";
  if (status === 401) explanation = "Источник не принял авторизацию.";
  else if (status === 403) explanation = "Источник запретил доступ к ресурсу.";
  else if (status === 404) explanation = "Источник не нашёл указанный путь или ресурс. Это ответ сервера, а не ошибка разбора конфигурации.";
  else if (status === 405) explanation = "Источник не поддерживает используемый HTTP-метод.";
  else if (status === 410) explanation = "Ресурс удалён или срок его действия истёк.";
  else if (status === 429) explanation = "Источник ограничил частоту запросов.";
  else if (status >= 500) explanation = "На стороне источника или промежуточного сервера произошла ошибка.";
  return {
    ok: false,
    error: "HTTP " + status + " " + statusName + ". " + explanation +
      " Адрес: " + (endpoint.target || endpoint.host || "неизвестен") +
      ". Этап: " + stage + ".",
    status, statusName, attempts, stage,
    endpoint: endpoint.target, host: endpoint.host, path: endpoint.path,
    contentType: response && response.headers && response.headers.get("content-type") || null,
  };
}

function logDecodeEvent(event) {
  // Do not log complete URLs, payload text, tokens, profile links, or device IDs.
  try { console.info(JSON.stringify(event)); } catch {}
}

function isBlockedDomainUrl(value) {
  try {
    const hostname = new URL(String(value || "")).hostname.toLowerCase().replace(/\.$/, "");
    return BLOCKED_DOMAINS.some(domain => {
      const blocked = domain.toLowerCase();
      return hostname === blocked || hostname.endsWith("." + blocked);
    });
  } catch {
    return false;
  }
}

function containsBlockedDomainInPayload(...values) {
  const text = values.map(value => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return ""; }
  }).join("\n");
  return BLOCKED_DOMAINS.some(domain => {
    const escaped = domain.split(".").join("\\.");
    return new RegExp("(^|[^a-z0-9.-])" + escaped + "(?=$|[^a-z0-9.-])", "i").test(text);
  });
}
function stripLeadingSubscriptionHeaders(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let firstConfigLine = 0;
  while (firstConfigLine < lines.length) {
    const line = lines[firstConfigLine].trim();
    if (!line || line.startsWith("#")) {
      firstConfigLine++;
      continue;
    }
    break;
  }
  return lines.slice(firstConfigLine).join(newline);
}

function cleanSubscriptionPayload(text) {
  // The source body is preserved verbatim except for leading metadata/comment lines.
  // Do not decode base64 or rebuild formats here; Happ receives what remained after headers.
  return stripLeadingSubscriptionHeaders(text);
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

function extractRedirectTarget(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname.includes("happ-redirect") || urlObj.pathname.includes("redirect")) {
      return urlObj.searchParams.get("url") || urlObj.searchParams.get("sub") || urlObj.searchParams.get("link") || urlObj.searchParams.get("target") || null;
    }
    return urlObj.searchParams.get("url") || null;
  } catch { return null; }
}

const DECODER_HEADERS_CACHE = new WeakMap();

function randomDigits(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, value => String(value % 10)).join("");
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function randomWindowsHwid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function buildDecoderHeaders(requestOptions = {}) {
  if (requestOptions && typeof requestOptions === "object" && DECODER_HEADERS_CACHE.has(requestOptions)) {
    return { ...DECODER_HEADERS_CACHE.get(requestOptions) };
  }

  const supplied = new Headers(requestOptions.deviceHeaders || {});
  const originalUserAgent = supplied.get("user-agent") || "";
  const androidProfile = /^Happ\/[\d.]+\/Android(?:\/([^/\s]+))?/i.test(originalUserAgent);
  const windowsProfile = /^Happ\/[\d.]+\/Windows(?:\/([^/\s]+))?/i.test(originalUserAgent);
  const headers = new Headers(supplied);

  // These are transport-managed or hop-by-hop headers. Cloudflare Fetch sets
  // them for its own outbound connection; copying client values is not valid.
  for (const name of [
    "accept",
    "accept-encoding",
    "connection",
    "host",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }

  if (androidProfile) {
    // The supplied reference is an older Android log: use the requested 4.8.0
    // application version and create fresh per-decode identifiers.
    headers.set("user-agent", "Happ/4.8.0/Android/" + randomDigits(20));
    headers.set("x-device-locale", "ru");
    headers.set("x-hwid", randomHex(8));
    headers.set("x-device-os", "Android");
    headers.set("x-ver-os", "16");
    headers.set("x-device-model", "2311DRK48G");
    headers.delete("x-app-version");
    headers.delete("accept-language");
  } else if (windowsProfile) {
    // Match the supplied real Windows request profile (Happ 4.5.4).
    headers.set("user-agent", "Happ/4.5.4/Windows/" + randomDigits(13));
    headers.set("x-app-version", "4.5.4");
    headers.set("x-device-locale", "RU");
    headers.set("x-device-os", "Windows");
    headers.set("x-device-model", "DESKTOP-AMMPFKL_x86_64");
    headers.set("x-hwid", randomWindowsHwid());
    headers.set("x-ver-os", "10_10.0.19045");
    headers.set("accept-language", "ru-RU,en,*");
  } else if (!headers.has("user-agent")) {
    headers.set("user-agent", DECODER_USER_AGENT);
  }

  const result = Object.fromEntries(headers.entries());
  if (requestOptions && typeof requestOptions === "object") {
    DECODER_HEADERS_CACHE.set(requestOptions, result);
  }
  return { ...result };
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
  if (/^\s*[\[{]/.test(c)) { try { JSON.parse(c); return true; } catch {} }
  if (/^(?:proxies|proxy-groups|mixed-port|port|mode)\s*:/im.test(c)) return true;
  if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(c.replace(/\s/g, ""))) {
    const d = safeBase64(c);
    if (d && /(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard):\/\//i.test(d)) return true;
  }
  return false;
}

async function fetchSubscription(url, trusted = false, requestOptions = {}, stage = "source") {
  try {
    if (isBlockedDomainUrl(url)) {
      return { ok: false, error: "🚫 Этот домен запрещён для декодирования", attempts: 0 };
    }
    if (trusted && (!requestOptions.upstreamSecret || !requestOptions.upstreamOrigin)) {
      return {
        ok: false,
        error: "Не настроен SUBSCRIPTION_UPSTREAM_SECRET или SUBSCRIPTION_UPSTREAM_ORIGIN",
        attempts: 0,
      };
    }
    const redirectTarget = extractRedirectTarget(url);
    const actualUrl = redirectTarget ? new URL(redirectTarget, url).toString() : url;
    let lastError = "Неизвестная ошибка", attempts = 0, bestContent = null, bestContentType = null;
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS = [0, 400, 1000];
    const headers = buildDecoderHeaders(requestOptions);
    const httpOptions = {
      ...requestOptions,
      headers,
      timeoutMs: 8000,
      maxRedirects: 5,
      extractRedirectTarget,
    };
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts = i + 1;
      try {
        if (i > 0) await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[i]));
        const res = await fetchWithRedirects(actualUrl, httpOptions);
        if (!res.ok) {
          const failure = describeHttpFailure(res, actualUrl, attempts, stage);
          logDecodeEvent({
            event: "subscription_decode_http_error",
            host: failure.host, path: failure.path,
            status: failure.status, statusName: failure.statusName,
            stage: failure.stage, attempt: attempts,
            contentType: failure.contentType,
          });
          lastError = failure.error;
          // Do not retry permanent 4xx responses: a repeated 404 cannot fix a missing route.
          const retryableStatus = res.status === 408 || res.status === 425 ||
            res.status === 429 || res.status >= 500;
          if (!retryableStatus || i === MAX_ATTEMPTS - 1) {
            return { ...failure, content: bestContent, contentType: bestContentType };
          }
          const retryAfter = Number(res.headers.get("retry-after"));
          if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(retryAfter * 1000, 2000)));
          }
          continue;
        }
        const rawText = await res.text();
        const text = normalizeText(rawText);
        const ct = res.headers.get("content-type") || "";
        const htmlLike = ct.includes("text/html") || /<html|<!doctype|<body|<script/i.test(text);
        const temporaryMessage = isTemporaryMessage(text);
        const stubResponse = isStubResponse(text);
        logDecodeEvent({
          event: "subscription_decode_body",
          host: safeHost(actualUrl),
          attempt: attempts,
          status: res.status,
          bodyLength: rawText.length,
          contentType: ct || null,
          empty: !text,
          temporaryMessage,
          stubResponse,
          html: htmlLike,
        });
        if (!text) { lastError = "Пустой ответ"; continue; }
        if (temporaryMessage) { lastError = "Сервер вернул временное сообщение"; continue; }
        if (stubResponse) { lastError = "Сервер вернул заглушку"; continue; }
        const envelopeUrl = unwrapEnvelope(text);
        if (envelopeUrl && envelopeUrl !== actualUrl) {
          try {
            const nested = await fetchWithRedirects(envelopeUrl, httpOptions);
            if (!nested.ok) {
              const failure = describeHttpFailure(nested, envelopeUrl, attempts, "envelope");
              logDecodeEvent({
                event: "subscription_decode_http_error",
                host: failure.host, path: failure.path,
                status: failure.status, statusName: failure.statusName,
                stage: failure.stage, attempt: attempts,
                contentType: failure.contentType,
              });
              return failure;
            }
            const nestedText = normalizeText(await nested.text());
            if (nestedText) return { ok: true, content: nestedText, rawContent: nestedText, contentType: nested.headers.get("content-type") || "text/plain", attempts };
          } catch {}
        }
        const isHtml = htmlLike;
        if (isHtml) {
          const allUrls = extractAllUrlsFromHtml(text, url).slice(0, 3);
          if (allUrls.length > 0) {
            const allContents = [];
            const candidateFailures = [];
            for (const subUrl of allUrls) {
              try {
                const subRes = await fetchWithRedirects(subUrl, httpOptions);
                if (!subRes.ok) {
                  candidateFailures.push(describeHttpFailure(subRes, subUrl, attempts, "html_candidate"));
                  continue;
                }
                const subText = normalizeText(await subRes.text());
                if (!subText || isStubResponse(subText) || isTemporaryMessage(subText)) continue;
                const subCt = subRes.headers.get("content-type") || "";
                if (/<html|<!doctype|<script/i.test(subText) || subCt.includes("text/html")) {
                  const nestedUrls = extractAllUrlsFromHtml(subText, subUrl).slice(0, 1);
                  for (const nestedUrl of nestedUrls) {
                    try {
                      const nestedRes = await fetchWithRedirects(nestedUrl, httpOptions);
                      if (nestedRes.ok) {
                        const nestedText = normalizeText(await nestedRes.text());
                        if (nestedText && !isStubResponse(nestedText) && !isTemporaryMessage(nestedText)) allContents.push(nestedText);
                      }
                    } catch {}
                  }
                } else allContents.push(subText);
              } catch {}
            }
            if (allContents.length > 0) { const extracted = allContents.join("\n"); return { ok: true, content: extracted, rawContent: extracted, contentType: "text/plain", attempts }; }
            const notFound = candidateFailures.find(failure => failure.status === 404);
            if (notFound) {
              logDecodeEvent({
                event: "subscription_decode_http_error",
                host: notFound.host, path: notFound.path,
                status: notFound.status, statusName: notFound.statusName,
                stage: notFound.stage, attempt: attempts,
                contentType: notFound.contentType,
              });
              return notFound;
            }
          }
        }
        // Не пытаемся распознать протокол в обычном текстовом ответе.
        // Сохраняем тело источника; ведущие заголовки будут удалены только перед выдачей.
        if (!isHtml) return { ok: true, content: text, rawContent: rawText, contentType: ct || "text/plain", attempts };
        const candidateUrls = extractAllUrlsFromHtml(text, url).slice(0, 3);
        if (candidateUrls.length > 0) { const extracted = candidateUrls.join("\n"); return { ok: true, content: extracted, rawContent: extracted, contentType: "text/plain", attempts }; }
        bestContent = rawText; bestContentType = ct || "text/plain"; lastError = "Не найдено поддерживаемых конфигураций";
      } catch (e) {
        lastError = (e?.name === "AbortError" || e?.name === "TimeoutError") ? "Таймаут запроса" : (e?.message || "Ошибка запроса");
        const endpoint = safeRequestTarget(actualUrl);
        logDecodeEvent({
          event: "subscription_decode_request_error",
          host: endpoint.host, path: endpoint.path, stage,
          attempt: attempts, errorType: e?.name || "Error",
          error: String(lastError).replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]").slice(0, 180),
        });
      }
    }
    const endpoint = safeRequestTarget(actualUrl);
    return { ok: false, error: lastError, attempts, content: bestContent, contentType: bestContentType, stage, endpoint: endpoint.target, host: endpoint.host, path: endpoint.path };
  } catch (e) { return { ok: false, error: e?.message || "Ошибка декодирования", attempts: 0 }; }
}

function detectFormat(content) {
  const c = normalizeText(content);
  if (/^(?:happ|incy|v2raytun):\/\//i.test(c)) return "envelope";
  if (/(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(c)) return "uri";
  if (/^\s*[\[{]/.test(c)) return "json";
  if (/^(?:proxies|proxy-groups|mixed-port|port|mode)\s*:/im.test(c)) return "yaml";
  return "base64";
}

export async function decodeSubscription(url, trusted = false, pingCheck = false, requestOptions = {}) {
  if (!url || typeof url !== "string") return { ok: false, error: "Не указана ссылка", configs: [], uris: [], attempts: 0 };
  const cleanUrl = url.trim().replace(/^<|>$/g, "");
  if (!/^https?:\/\//i.test(cleanUrl)) return { ok: false, error: "Нужна HTTP(S)-ссылка", configs: [], uris: [], attempts: 0 };
  const decoderRequestOptions = { ...requestOptions };
  const result = await fetchSubscription(cleanUrl, trusted, decoderRequestOptions, "source");
  if (!result.ok) {
    logDecodeEvent({
      event: "subscription_decode_result",
      host: result.host || safeHost(cleanUrl),
      path: result.path || safeRequestTarget(cleanUrl).path,
      ok: false,
      attempts: Number(result.attempts) || 0,
      status: Number(result.status) || null,
      stage: result.stage || "source",
      errorCategory: result.status
        ? "http_status"
        : /таймаут/i.test(String(result.error || "")) ? "timeout"
        : /заглушк/i.test(String(result.error || "")) ? "stub_response"
        : /пуст/i.test(String(result.error || "")) ? "empty_response"
        : /временн/i.test(String(result.error || "")) ? "temporary_response"
        : /не найдено поддерживаемых/i.test(String(result.error || "")) ? "no_supported_payload"
        : "request_or_decode_error",
    });
    return { ...result, configs: [], uris: [] };
  }
  // Preserve the upstream body for storage and later HTTP metadata reconstruction.
  // Parse a separate payload with only the leading comment/metadata lines removed.
  let rawContent = typeof result.rawContent === "string" ? result.rawContent : (result.content || "");
  let content = cleanSubscriptionPayload(rawContent);
  if (!content.trim()) return { ok: false, error: "После удаления заголовков содержимое пустое", configs: [], uris: [], attempts: result.attempts };
  const format = detectFormat(content);
  let parsed = [];
  let finalFormat = format;
  try {
    if (format === "envelope") {
      const nestedUrl = unwrapEnvelope(content);
      if (nestedUrl) {
        const nested = await fetchSubscription(nestedUrl, trusted, decoderRequestOptions, "envelope");
        if (!nested.ok) {
          logDecodeEvent({
            event: "subscription_decode_result",
            host: nested.host || safeHost(nestedUrl),
            path: nested.path || safeRequestTarget(nestedUrl).path,
            ok: false,
            attempts: Number(nested.attempts) || 0,
            status: Number(nested.status) || null,
            stage: nested.stage || "envelope",
            errorCategory: nested.status ? "http_status" : "nested_request_error",
          });
          return { ...nested, configs: [], uris: [] };
        }
        rawContent = typeof nested.rawContent === "string" ? nested.rawContent : (nested.content || "");
        content = cleanSubscriptionPayload(rawContent);
      }
    }
    finalFormat = detectFormat(content);
    let parseResult;
    if (finalFormat === "uri") parseResult = parseVlessList(content);
    else if (finalFormat === "json") parseResult = parseJson(content);
    else if (finalFormat === "yaml") parseResult = parseYaml(content);
    else if (finalFormat === "crypt") parseResult = parseCrypt(content);
    else if (finalFormat === "empty") parseResult = { ok: false, error: "Пустая подписка" };
    else parseResult = parseBase64(content);

    // Парсер используется только для необязательной статистики. Ошибка распознавания
    // не должна мешать сохранить исходное содержимое подписки.
    if (parseResult && parseResult.ok === false) parseResult = [];

    parsed = Array.isArray(parseResult) ? parseResult : (Array.isArray(parseResult?.uris) ? parseResult.uris : []);
    if (!parsed.length && finalFormat !== "crypt") {
      try {
        const crypt = parseCrypt(content);
        if (crypt?.ok !== false) {
          if (Array.isArray(crypt)) parsed = crypt;
          else if (Array.isArray(crypt?.uris)) parsed = crypt.uris;
        }
      } catch {}
    }
  } catch (e) {
    // A parser failure must not discard an otherwise successful upstream body.
    console.warn("[Decoder] Parser diagnostics skipped; raw payload will be preserved:", e?.message || e);
    parsed = [];
  }
  const uris = parsed.map(x => typeof x === "string" ? x : x?.uri).filter(Boolean);
  // Block not only input hosts, but also a decoded/crypt payload that resolves to a protected host.
  if (containsBlockedDomainInPayload(rawContent, parsed, uris)) {
    logDecodeEvent({
      event: "subscription_decode_result",
      host: safeHost(cleanUrl),
      ok: false,
      attempts: Number(result.attempts) || 0,
      errorCategory: "blocked_domain_in_decoded_payload",
    });
    return {
      ok: false,
      error: "🚫 В расшифрованном содержимом обнаружен запрещённый домен",
      configs: [],
      uris: [],
      attempts: result.attempts,
    };
  }
  // Даже если внутренний парсер не распознал формат, исходное тело остаётся полезным payload для Happ.
  if (!rawContent.trim()) return { ok: false, error: "Пустая подписка после удаления заголовков", configs: [], uris: [], attempts: result.attempts, format: finalFormat || format };
  let aliveFlags;
  if (pingCheck && uris.length) aliveFlags = await checkServersAlive(uris);
  logDecodeEvent({
    event: "subscription_decode_result",
    host: safeHost(cleanUrl),
    ok: true,
    attempts: Number(result.attempts) || 0,
    format: finalFormat || format,
    configCount: parsed.length,
    uriCount: uris.length,
    bodyLength: rawContent.length,
    contentType: result.contentType || "text/plain",
  });
  return { ok: true, configs: parsed, uris, aliveFlags, attempts: result.attempts, format: finalFormat || format, rawContent, contentType: result.contentType || "text/plain", metadata: parsed?.metadata || {} };
}

async function checkServerAlive(uri, timeoutMs = 2500) {
  const hp = (() => {
    try {
      if (uri.startsWith("vmess://")) {
        const decoded = safeBase64(uri.substring(8));
        if (!decoded) return null;
        const json = JSON.parse(decoded);
        const port = parseInt(json.port, 10);
        return json.add && port ? { host: json.add, port } : null;
      }
      const m = uri.match(/@([^:/?#]+):(\d+)/);
      return m ? { host: m[1], port: parseInt(m[2], 10) } : null;
    } catch { return null; }
  })();
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

async function checkServersAlive(uris) {
  const results = new Array(uris.length).fill(false);
  let idx = 0;
  async function worker() {
    while (idx < uris.length) {
      const i = idx++;
      results[i] = await checkServerAlive(uris[i]);
    }
  }
  const workerCount = Math.max(1, Math.min(8, uris.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export { fetchSubscription, checkServerAlive, checkServersAlive };
