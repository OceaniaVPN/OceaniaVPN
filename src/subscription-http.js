import { parseHttpProxyEndpoint } from "./proxy-check.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const APP_SCHEME_PATTERN = /^(?:happ|incy|v2raytun):\/\//i;

function safeOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Таймаут запроса (${timeoutMs} мс)`);
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET helper for subscription URLs.
 * API credentials are sent only to their explicitly configured origins and
 * are never forwarded to a different host after a redirect.
 */

async function fetchViaHttpProxy(url, options, proxyEndpoint, timeoutMs) {
  const { probeOnly = false } = options || {};
  const proxy = parseHttpProxyEndpoint(proxyEndpoint);
  if (!proxy) throw new Error("Некорректный прокси или прокси отсутствует в списке");

  const hostname = proxy.hostname.includes(":") && !proxy.hostname.startsWith("[")
    ? `[${proxy.hostname}]`
    : proxy.hostname;
  const proxyUrl = `${proxy.protocol}://${hostname}:${proxy.port}`;

  try {
    return await fetchThroughProxy(url, proxyUrl, {
      headers: options?.headers || {},
      timeoutMs,
      probeOnly,
    });
  } catch (error) {
    const message = String(error?.message || error || "Ошибка прокси");
    if (/timeout|deadline/i.test(message)) {
      throw new Error(`Тайм-аут на этапе соединения через прокси (${timeoutMs} мс): ${message}`);
    }
    throw new Error(`Запрос через прокси не выполнен: ${message}`);
  }
}

export async function fetchWithRedirects(initialUrl, options = {}) {
  const {
    headers = {},
    maxRedirects = 5,
    timeoutMs = 8000,
    apiToken = "",
    apiOrigin = "",
    upstreamSecret = "",
    upstreamOrigin = "",
    extractRedirectTarget = () => null,
    proxyEndpoint = "",
    probeOnly = false,
  } = options;

  let currentUrl = new URL(initialUrl).toString();
  const apiAllowedOrigin = safeOrigin(apiOrigin);
  const upstreamAllowedOrigin = safeOrigin(upstreamOrigin);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = new URL(currentUrl);
    const requestHeaders = new Headers(headers);

    if (apiToken && apiAllowedOrigin && target.origin === apiAllowedOrigin && target.pathname === "/sub") {
      requestHeaders.set("Authorization", `Bearer ${apiToken}`);
    }
    if (upstreamSecret && upstreamAllowedOrigin && target.origin === upstreamAllowedOrigin && target.pathname === "/sub") {
      requestHeaders.set("X-Bot-Secret", upstreamSecret);
    }

    const response = proxyEndpoint
      ? await fetchViaHttpProxy(currentUrl, { headers: requestHeaders, probeOnly }, proxyEndpoint, timeoutMs)
      : await fetchWithTimeout(currentUrl, {
          method: "GET",
          headers: requestHeaders,
          redirect: "manual",
        }, timeoutMs);

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    const trimmedLocation = location.trim();
    if (APP_SCHEME_PATTERN.test(trimmedLocation)) {
      return new Response(trimmedLocation, {
        status: 200,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }

    currentUrl = new URL(trimmedLocation, target).toString();
    const extracted = extractRedirectTarget(currentUrl);
    if (extracted) currentUrl = new URL(extracted, currentUrl).toString();
  }

  throw new Error(`Превышен лимит перенаправлений (${maxRedirects})`);
}

/**
 * Probe only the HTTP status/headers through the selected proxy. Never returns
 * response bodies because subscription responses may include private configs.
 */
export async function probeHttpProxyTarget(url, options = {}) {
  const started = Date.now();
  if (!options.proxyEndpoint) {
    return { status: null, ms: Date.now() - started, error: "Не выбран HTTP-прокси" };
  }
  try {
    const response = await fetchWithRedirects(url, {
      ...options,
      probeOnly: true,
      timeoutMs: Number(options.timeoutMs) || 6000,
      maxRedirects: Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5,
    });
    return { status: response.status, ms: Date.now() - started, error: null };
  } catch (error) {
    const message = String(error?.message || "Ошибка запроса")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
      .slice(0, 180);
    return { status: null, ms: Date.now() - started, error: message };
  }
}
