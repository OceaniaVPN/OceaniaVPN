import { connect } from "cloudflare:sockets";
import { parseHttpProxyEndpoint } from "./proxy-check.js";
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
  const target = new URL(url);
  const proxy = parseHttpProxyEndpoint(proxyEndpoint);
  if (!proxy) throw new Error("Некорректный HTTP-прокси");

  // HTTPS is negotiated after the HTTP CONNECT tunnel is established.
  // Cloudflare requires the socket to be created in STARTTLS mode before
  // startTls() can upgrade the tunnel.
  let socket = connect(
    { hostname: proxy.hostname, port: proxy.port },
    { secureTransport: "starttls" },
  );
  let timeoutId;
  let reader;
  let writer;
  const timeout = async (promise) => {
    let id;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          id = setTimeout(() => reject(new Error(`Таймаут запроса через прокси (${timeoutMs} мс)`)), timeoutMs);
          timeoutId = id;
        }),
      ]);
    } finally {
      if (id) clearTimeout(id);
      if (timeoutId === id) timeoutId = null;
    }
  };
  const readUntil = async (streamReader, marker, limit = 16384) => {
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(marker) && text.length < limit) {
      const part = await timeout(streamReader.read());
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
    }
    if (!text.includes(marker)) throw new Error("Некорректный ответ HTTP-прокси");
    return text;
  };

  try {
    await timeout(socket.opened);
    writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(
      `CONNECT ${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)} HTTP/1.1\r\n` +
      `Host: ${target.hostname}:${target.port || (target.protocol === "https:" ? 443 : 80)}\r\n` +
      "Proxy-Connection: Keep-Alive\r\n\r\n"
    ));
    writer.releaseLock();
    writer = null;

    reader = socket.readable.getReader();
    const connectResponse = await readUntil(reader, "\r\n\r\n", 8192);
    const statusLine = connectResponse.split(/\r?\n/, 1)[0] || "";
    const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    if (!statusMatch || Number(statusMatch[1]) !== 200) {
      throw new Error(`HTTP-прокси отклонил CONNECT: ${statusLine || "нет ответа"}`);
    }
    reader.releaseLock();
    reader = null;

    if (target.protocol === "https:") {
      socket = socket.startTls({ expectedServerHostname: target.hostname });
      await timeout(socket.opened);
    }

    const requestHeaders = new Headers(options.headers || {});
    requestHeaders.set("Host", target.host);
    requestHeaders.set("Connection", "close");
    requestHeaders.set("Accept-Encoding", "identity");
    const path = `${target.pathname || "/"}${target.search}`;
    const requestText = `GET ${path} HTTP/1.1\r\n` +
      [...requestHeaders.entries()].map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";

    writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(requestText));
    writer.releaseLock();
    writer = null;

    reader = socket.readable.getReader();
    const chunks = [];
    let total = 0;
    let raw = new Uint8Array(0);
    let headerEnd = -1;
    let expectedLength = null;
    let chunked = false;
    while (true) {
      const part = await timeout(reader.read());
      if (part.done) break;
      chunks.push(part.value);
      total += part.value.length;
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      raw = joined;
      if (headerEnd < 0) {
        for (let i = 0; i < raw.length - 3; i++) {
          if (raw[i] === 13 && raw[i+1] === 10 && raw[i+2] === 13 && raw[i+3] === 10) { headerEnd = i + 4; break; }
        }
        if (headerEnd >= 0) {
          const headerText = new TextDecoder().decode(raw.slice(0, headerEnd));
          const lengthMatch = headerText.match(/\r\ncontent-length:\s*(\d+)/i);
          expectedLength = lengthMatch ? Number(lengthMatch[1]) : null;
          chunked = /\r\ntransfer-encoding:\s*[^\r\n]*chunked/i.test(headerText);
        }
      }
      if (headerEnd >= 0) {
        const bodyLength = raw.length - headerEnd;
        if (expectedLength !== null && bodyLength >= expectedLength) break;
        if (chunked && new TextDecoder().decode(raw.slice(headerEnd)).includes("\r\n0\r\n\r\n")) break;
      }
    }
    if (headerEnd < 0) throw new Error("Прокси не вернул HTTP-ответ");
    const headerText = new TextDecoder().decode(raw.slice(0, headerEnd));
    const lines = headerText.split("\r\n");
    const status = Number((lines.shift().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1] || 502);
    const responseHeaders = new Headers();
    for (const line of lines) {
      const index = line.indexOf(":");
      if (index > 0) responseHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    let body = raw.slice(headerEnd);
    if (expectedLength !== null) body = body.slice(0, expectedLength);
    if (chunked) {
      const encoded = new TextDecoder().decode(body);
      let decoded = "";
      let cursor = 0;
      while (cursor < encoded.length) {
        const lineEnd = encoded.indexOf("\r\n", cursor);
        if (lineEnd < 0) break;
        const size = parseInt(encoded.slice(cursor, lineEnd).split(";")[0], 16);
        if (!Number.isFinite(size) || size <= 0) break;
        const start = lineEnd + 2;
        decoded += encoded.slice(start, start + size);
        cursor = start + size + 2;
      }
      body = new TextEncoder().encode(decoded);
      responseHeaders.delete("transfer-encoding");
    }
    return new Response(body, { status, headers: responseHeaders });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try { if (reader) reader.releaseLock(); } catch {}
    try { if (writer) writer.releaseLock(); } catch {}
    try { await socket.close(); } catch {}
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
      ? await fetchViaHttpProxy(currentUrl, { headers: requestHeaders }, proxyEndpoint, timeoutMs)
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
