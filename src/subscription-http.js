import { parseHttpProxyEndpoint } from "./proxy-check.js";
import { connectTcpSocket, upgradeSocketToTls } from "./proxy-transport.js";
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
  const target = new URL(url);
  const proxy = parseHttpProxyEndpoint(proxyEndpoint);
  if (!proxy) throw new Error("Некорректный прокси или прокси отсутствует в списке");

  // Cloudflare Sockets permits one startTls() upgrade per TCP socket.
  // HTTPS proxy -> HTTPS origin needs nested TLS, which this transport cannot
  // provide. Fail explicitly instead of returning a misleading closed-stream error.
  if (proxy.protocol === "https" && target.protocol === "https:") {
    throw new Error("Связка HTTPS-прокси → HTTPS-подписка требует вложенный TLS, который не поддерживается Cloudflare Sockets. Выбери SOCKS5 или обычный HTTP-прокси для HTTPS-ссылки.");
  }

  let socket = connectTcpSocket(proxy.hostname, proxy.port);
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

  let phase = "подключение к прокси";
  const write = async (bytes) => {
    writer = socket.writable.getWriter();
    try { await timeout(writer.write(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes))); }
    finally { try { writer.releaseLock(); } catch {} writer = null; }
  };
const readerBuffers = new WeakMap();

  // A timed-out reader.read() stays pending after Promise.race rejects.
  // Cancel it before unlocking to avoid "releaseLock with outstanding read promises".
  const read = async (streamReader) => {
    try {
      return await timeout(streamReader.read());
    } catch (error) {
      try { await streamReader.cancel(error); } catch {}
      throw error;
    }
  };

  const readExact = async (streamReader, length) => {
    let pending = readerBuffers.get(streamReader) || new Uint8Array(0);
    while (pending.length < length) {
      const part = await read(streamReader);
      if (part.done) throw new Error(`Прокси закрыл соединение на этапе ${phase}`);
      const joined = new Uint8Array(pending.length + part.value.length);
      joined.set(pending, 0);
      joined.set(part.value, pending.length);
      pending = joined;
    }
    const result = pending.slice(0, length);
    readerBuffers.set(streamReader, pending.slice(length));
    return result;
  };
  const establishSocks5 = async (hostname, port) => {
    phase = "согласование SOCKS5";
    await write(Uint8Array.of(5, 1, 0));
    reader = socket.readable.getReader();
    const greeting = await readExact(reader, 2);
    if (greeting[0] !== 5) throw new Error("Ответ прокси не похож на SOCKS5");
    if (greeting[1] === 255) throw new Error("SOCKS5 не принимает подключение без авторизации");
    if (greeting[1] !== 0) throw new Error("SOCKS5 выбрал неподдерживаемый способ авторизации");

    const hostBytes = new TextEncoder().encode(hostname);
    if (!hostBytes.length || hostBytes.length > 255) throw new Error("Некорректное имя целевого хоста");
    const request = new Uint8Array(7 + hostBytes.length);
    request.set([5, 1, 0, 3, hostBytes.length], 0);
    request.set(hostBytes, 5);
    request[5 + hostBytes.length] = (port >> 8) & 255;
    request[6 + hostBytes.length] = port & 255;
    await write(request);

    const head = await readExact(reader, 4);
    if (head[0] !== 5) throw new Error("Некорректный ответ SOCKS5");
    if (head[1] !== 0) {
      const reasons = { 1: "общая ошибка", 2: "доступ запрещён", 3: "сеть недоступна", 4: "хост недоступен", 5: "соединение отклонено", 6: "TTL истёк", 7: "команда не поддерживается", 8: "тип адреса не поддерживается" };
      throw new Error(`SOCKS5 не смог подключиться: ${reasons[head[1]] || `ошибка ${head[1]}`}`);
    }
    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await readExact(reader, 1))[0] : 0;
    if (!addressLength) throw new Error("SOCKS5 вернул неизвестный тип адреса");
    await readExact(reader, addressLength + 2);
    try { reader.releaseLock(); } catch {}
    reader = null;
  };

  const establishHttpConnect = async (hostname, port) => {
    phase = "HTTP CONNECT";
    await write(
      `CONNECT ${hostname}:${port} HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      "Proxy-Connection: Keep-Alive\r\n\r\n"
    );
    reader = socket.readable.getReader();
    let response = "";
    while (!response.includes("\r\n\r\n") && response.length < 8192) {
      const part = await read(reader);
      if (part.done) break;
      response += new TextDecoder().decode(part.value, { stream: true });
    }
    const statusLine = response.split(/\r?\n/, 1)[0] || "";
    const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    if (!statusMatch || Number(statusMatch[1]) !== 200) {
      if (Number(statusMatch?.[1]) === 407) throw new Error("HTTP-прокси требует авторизацию");
      throw new Error(`Прокси отклонил CONNECT: ${statusLine || "нет ответа"}`);
    }
    try { reader.releaseLock(); } catch {}
    reader = null;
  };

  try {
    phase = "ожидание соединения с прокси";
    await timeout(socket.opened);
    if (proxy.protocol === "https") {
      phase = "TLS до HTTPS-прокси";
      socket = upgradeSocketToTls(socket, proxy.hostname);
      await timeout(socket.opened);
    }

    const targetPort = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    if (proxy.protocol === "socks5") {
      // SOCKS5 always establishes a TCP tunnel; HTTP is sent through it.
      await establishSocks5(target.hostname, targetPort);
    } else if (target.protocol === "https:") {
      // HTTPS over an HTTP(S) proxy requires CONNECT before origin TLS.
      await establishHttpConnect(target.hostname, targetPort);
    }
    // For an http:// origin behind an HTTP(S) proxy, skip CONNECT and use
    // absolute-form in the HTTP request below, as required for forward proxies.

    if (target.protocol === "https:") {
      phase = proxy.protocol === "https" ? "вложенный TLS через HTTPS-прокси" : "TLS через туннель";
      socket = upgradeSocketToTls(socket, target.hostname);
      await timeout(socket.opened);
    }

    phase = "ожидание HTTP-ответа целевого сервера";
    const requestHeaders = new Headers(options.headers || {});
    requestHeaders.set("Host", target.host);
    requestHeaders.set("Connection", "close");
    requestHeaders.set("Accept-Encoding", "identity");
    const path = `${target.pathname || "/"}${target.search}`;
    const requestTarget = target.protocol === "http:" && proxy.protocol !== "socks5"
      ? target.toString()
      : path;
    phase = "отправка HTTP-запроса целевому серверу";
    const requestText = `GET ${requestTarget} HTTP/1.1\r\n` +
      [...requestHeaders.entries()].map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";

    await write(requestText);
    phase = "ожидание HTTP-ответа целевого сервера";
    reader = socket.readable.getReader();
    const chunks = [];
    let total = 0;
    let raw = new Uint8Array(0);
    let headerEnd = -1;
    let expectedLength = null;
    let chunked = false;
    while (true) {
      const part = await read(reader);
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
      if (headerEnd >= 0 && probeOnly) break;
      if (headerEnd >= 0) {
        const bodyLength = raw.length - headerEnd;
        if (expectedLength !== null && bodyLength >= expectedLength) break;
        if (chunked && new TextDecoder().decode(raw.slice(headerEnd)).includes("\r\n0\r\n\r\n")) break;
      }
    }
    if (headerEnd < 0) {
      const receivedBytes = raw.length;
      throw new Error(receivedBytes
        ? `Соединение закрыто до получения HTTP-заголовков от ${target.hostname} (этап: ${phase}, получено байт: ${receivedBytes})`
        : target.protocol === "https:"
          ? `После SOCKS5/CONNECT нет HTTP-ответа от ${target.hostname}. Возможная причина: Cloudflare Workers startTls() через прокси на production edge не передаёт SNI целевого хоста (известное ограничение runtime); проверка URL сама по себе этого не исправит. Нужен транспорт с корректным TLS SNI или отдельный relay.`
          : `Туннель через прокси установлен, но ${target.hostname} закрыл соединение без HTTP-ответа (этап: ${phase}). Проверь адрес подписки и ограничения прокси по целевому хосту`);
    }
    const headerText = new TextDecoder().decode(raw.slice(0, headerEnd));
    const lines = headerText.split("\r\n");
    const status = Number((lines.shift().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i) || [])[1] || 502);
    const responseHeaders = new Headers();
    for (const line of lines) {
      const index = line.indexOf(":");
      if (index > 0) responseHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
    if (probeOnly) return new Response(null, { status, headers: responseHeaders });
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
        const bodyStart = lineEnd + 2;
        decoded += encoded.slice(bodyStart, bodyStart + size);
        cursor = bodyStart + size + 2;
      }
      body = new TextEncoder().encode(decoded);
      responseHeaders.delete("transfer-encoding");
    }
    return new Response(body, { status, headers: responseHeaders });
  } catch (error) {
    if (error?.name === "TimeoutError" || /Таймаут запроса через прокси/.test(String(error?.message || ""))) {
      throw new Error(`Тайм-аут на этапе «${phase}»: прокси не ответил вовремя`);
    }
    if (/TLS|certificate|cert|handshake/i.test(String(error?.message || "")) && phase.includes("TLS")) {
      throw new Error(`Не удалось установить TLS на этапе «${phase}»: ${error.message}`);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    // Settle any outstanding read before releasing the reader lock.
    if (reader) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
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
