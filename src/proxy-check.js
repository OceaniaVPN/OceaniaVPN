import proxyListText from "./proxy-list.txt";
import { connectTcpSocket, upgradeSocketToTls } from "./proxy-transport.js";

const FLAG_BY_COUNTRY = Object.freeze({
  "США": "🇺🇸", "Франция": "🇫🇷", "Турция": "🇹🇷", "Польша": "🇵🇱",
  "Греция": "🇬🇷", "Италия": "🇮🇹", "Испания": "🇪🇸", "Великобритания": "🇬🇧",
  "Болгария": "🇧🇬", "Германия": "🇩🇪", "Нидерланды": "🇳🇱", "Румыния": "🇷🇴",
  "Украина": "🇺🇦", "Австрия": "🇦🇹", "Чехия": "🇨🇿",
});

const ENDPOINT_RE = /^(?:(?:http|https|socks5):\/\/)?(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/i;

function parseEndpointShape(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase().replace(":", "");
  if (!["http", "https", "socks5"].includes(protocol)) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  const hostname = url.hostname;
  const port = Number(url.port);
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // Accept IPv4 addresses and DNS names; IPv6 URL hostnames are also valid.
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) &&
      !/^[a-z0-9.-]+$/i.test(hostname) && !hostname.includes(":")) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    if (hostname.split(".").some(part => Number(part) > 255)) return null;
  }
  return { hostname, port, protocol };
}

function isProxyEntry(line) {
  return ENDPOINT_RE.test(line) ||
    /^(?:http|https|socks5):\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(line);
}

function parseProxyList(source) {
  const countries = [];
  let current = null;
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (isProxyEntry(line) && parseEndpointShape(line)) {
      if (current) current.servers.push(line);
      continue;
    }
    if (current?.servers.length) countries.push(current);
    current = { name: line, flag: FLAG_BY_COUNTRY[line] || "🌐", servers: [] };
  }
  if (current?.servers.length) countries.push(current);
  return countries;
}

// Legacy IP:port values remain supported as HTTP CONNECT proxies.
export const HTTP_PROXY_COUNTRIES = parseProxyList(proxyListText);

export function findHttpProxy(endpoint) {
  const value = String(endpoint || "").trim();
  for (const country of HTTP_PROXY_COUNTRIES) {
    if (country.servers.includes(value)) return { country, endpoint: value };
  }
  return null;
}

export function isKnownHttpProxyEndpoint(endpoint) {
  return Boolean(findHttpProxy(endpoint) && parseEndpointShape(endpoint));
}

export function parseHttpProxyEndpoint(endpoint) {
  const known = findHttpProxy(endpoint);
  const parsed = parseEndpointShape(endpoint);
  if (!known || !parsed) return null;
  return { ...parsed, country: known.country.name };
}

const TIMEOUT_MS = 3500;

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function writeBytes(socket, bytes) {
  const writer = socket.writable.getWriter();
  try { await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
  finally { writer.releaseLock(); }
}

async function readExact(reader, length) {
  const chunks = [];
  let received = 0;
  while (received < length) {
    const part = await withTimeout(reader.read());
    if (part.done) throw new Error("Соединение закрыто во время согласования протокола");
    chunks.push(part.value);
    received += part.value.length;
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return joined.slice(0, length);
}

async function socks5Tunnel(socket, hostname, port) {
  await writeBytes(socket, Uint8Array.of(5, 1, 0));
  let reader = socket.readable.getReader();
  try {
    const greeting = await readExact(reader, 2);
    if (greeting[0] !== 5) throw new Error("Ответ не похож на SOCKS5");
    if (greeting[1] === 255) throw new Error("SOCKS5 не принимает подключение без авторизации");
    if (greeting[1] !== 0) throw new Error("SOCKS5 выбрал неподдерживаемый способ авторизации");

    const hostBytes = new TextEncoder().encode(hostname);
    if (hostBytes.length > 255) throw new Error("Слишком длинное имя целевого хоста");
    const request = new Uint8Array(7 + hostBytes.length);
    request.set([5, 1, 0, 3, hostBytes.length], 0);
    request.set(hostBytes, 5);
    request[5 + hostBytes.length] = (port >> 8) & 255;
    request[6 + hostBytes.length] = port & 255;
    await writeBytes(socket, request);

    const head = await readExact(reader, 4);
    if (head[0] !== 5) throw new Error("Некорректный ответ SOCKS5");
    if (head[1] !== 0) {
      const reasons = { 1: "общая ошибка", 2: "доступ запрещён", 3: "сеть недоступна", 4: "хост недоступен", 5: "соединение отклонено", 6: "TTL истёк", 7: "команда не поддерживается", 8: "тип адреса не поддерживается" };
      throw new Error(`SOCKS5: ${reasons[head[1]] || `ошибка ${head[1]}`}`);
    }
    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await readExact(reader, 1))[0] : 0;
    if (!addressLength) throw new Error("SOCKS5 вернул неизвестный тип адреса");
    await readExact(reader, addressLength + 2);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function httpConnectTunnel(socket, hostname, port) {
  await writeBytes(socket, new TextEncoder().encode(
    `CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`
  ));
  const reader = socket.readable.getReader();
  try {
    let response = "";
    while (!response.includes("\r\n\r\n") && response.length < 8192) {
      const part = await withTimeout(reader.read());
      if (part.done) break;
      response += new TextDecoder().decode(part.value, { stream: true });
    }
    const statusLine = response.split(/\r?\n/, 1)[0] || "";
    const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    const status = match ? Number(match[1]) : null;
    if (status !== 200) {
      if (status === 407) throw new Error("HTTP-прокси требует авторизацию");
      throw new Error(status ? `HTTP-прокси ответил ${status}` : "HTTP CONNECT не получил корректный ответ");
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export async function checkProxyTcp(endpoint) {
  const proxy = parseHttpProxyEndpoint(endpoint);
  if (!proxy) return { ok: false, ms: null, reason: "Некорректный или отсутствующий в списке адрес" };
  let socket;
  const started = Date.now();
  try {
    socket = connectTcpSocket(proxy.hostname, proxy.port);
    await withTimeout(socket.opened);
    if (proxy.protocol === "https") {
      socket = upgradeSocketToTls(socket, proxy.hostname);
      await withTimeout(socket.opened);
    }
    if (proxy.protocol === "socks5") {
      await socks5Tunnel(socket, "example.com", 443);
    } else {
      await httpConnectTunnel(socket, "example.com", 443);
    }
    const ms = Date.now() - started;
    const label = proxy.protocol === "socks5" ? "SOCKS5-туннель работает" :
      proxy.protocol === "https" ? "HTTPS-прокси и CONNECT работают" : "HTTP CONNECT работает";
    return { ok: true, ms, reason: label, protocol: proxy.protocol };
  } catch (error) {
    const message = String(error?.message || error || "").toLowerCase();
    return {
      ok: false,
      ms: null,
      reason: message.includes("timeout") ? `Тайм-аут ${TIMEOUT_MS} мс` :
        String(error?.message || "Проверка прокси не удалась").slice(0, 140),
      protocol: proxy.protocol,
    };
  } finally {
    try { if (socket) await socket.close(); } catch {}
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

export async function checkCountryProxies(country) {
  return mapLimit(country.servers, 4, async (endpoint) => ({ endpoint, ...(await checkProxyTcp(endpoint)) }));
}
