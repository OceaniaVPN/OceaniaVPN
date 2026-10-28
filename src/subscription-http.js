import { parseHttpProxyEndpoint } from "./proxy-check.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const APP_SCHEME_PATTERN = /^(?:happ|incy|v2raytun):\/\//i;

const BLOCKED_SUBSCRIPTION_HOSTS = [
  "sub.chkav-vpn.workers.dev",
];

function isBlockedSubscriptionHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return BLOCKED_SUBSCRIPTION_HOSTS.some(domain =>
    host === domain || host.endsWith("." + domain)
  );
}

function safeOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

function routeLabel(pathname) {
  if (pathname === "/") return "root";
  if (pathname === "/sub") return "subscription-endpoint";
  if (/^\/api(?:\/|$)/i.test(pathname)) return "api";
  return "other";
}

function logRequestEvent(event) {
  // Never log full URLs, query strings, Authorization values, bot secrets,
  // subscription bodies, device IDs, or proxy credentials.
  try { console.info(JSON.stringify(event)); } catch {}
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
  const proxyScheme = proxy.protocol === "socks5" ? "socks5h" : proxy.protocol;
  const proxyUrl = `${proxyScheme}://${hostname}:${proxy.port}`;

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
    // Enforce the denylist on every hop, including redirects and nested URLs.
    // This applies to direct fetch and proxy-tunnel transports equally.
    if (isBlockedSubscriptionHost(target.hostname)) {
      throw new Error("Домен запрещён для декодирования");
    }
    const requestHeaders = new Headers(headers);

    if (apiToken && apiAllowedOrigin && target.origin === apiAllowedOrigin && target.pathname === "/sub") {
      requestHeaders.set("Authorization", `Bearer ${apiToken}`);
    }
    if (upstreamSecret && upstreamAllowedOrigin && target.origin === upstreamAllowedOrigin && target.pathname === "/sub") {
      requestHeaders.set("X-Bot-Secret", upstreamSecret);
    }

    const hopStartedAt = Date.now();
    const transport = proxyEndpoint ? "explicit-proxy-tunnel" : "worker-fetch";
    let response;
    try {
      response = proxyEndpoint
        ? await fetchViaHttpProxy(currentUrl, { headers: requestHeaders, probeOnly }, proxyEndpoint, timeoutMs)
        : await fetchWithTimeout(currentUrl, {
            method: "GET",
            headers: requestHeaders,
            redirect: "manual",
          }, timeoutMs);
    } catch (error) {
      logRequestEvent({
        event: "subscription_http_error",
        host: target.hostname,
        protocol: target.protocol.replace(":", ""),
        route: routeLabel(target.pathname),
        transport,
        redirectHop: hop,
        elapsedMs: Date.now() - hopStartedAt,
        errorType: error?.name || "Error",
        // Whether credentials were attached, not their values.
        authorizationHeaderPresent: requestHeaders.has("authorization"),
        botSecretHeaderPresent: requestHeaders.has("x-bot-secret"),
      });
      throw error;
    }

    const isRedirect = REDIRECT_STATUSES.has(response.status);
    const location = response.headers.get("location");
    logRequestEvent({
      event: "subscription_http_response",
      host: target.hostname,
      protocol: target.protocol.replace(":", ""),
      route: routeLabel(target.pathname),
      transport,
      redirectHop: hop,
      status: response.status,
      elapsedMs: Date.now() - hopStartedAt,
      contentType: response.headers.get("content-type") || null,
      serverHeaderPresent: response.headers.has("server"),
      cfRayPresent: response.headers.has("cf-ray"),
      redirect: isRedirect,
      locationPresent: Boolean(location),
      userAgentPresent: requestHeaders.has("user-agent"),
      acceptPresent: requestHeaders.has("accept"),
      authorizationHeaderPresent: requestHeaders.has("authorization"),
      botSecretHeaderPresent: requestHeaders.has("x-bot-secret"),
    });

    if (!isRedirect) return response;
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
