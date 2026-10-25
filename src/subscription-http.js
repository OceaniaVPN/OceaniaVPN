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

    const response = await fetchWithTimeout(currentUrl, {
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
