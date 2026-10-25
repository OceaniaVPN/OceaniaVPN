import { connect } from "cloudflare:sockets";
import proxyListText from "./proxy-list.txt";

// Source: proxy.txt supplied for this project. These are public endpoints;
// the checker measures TCP reachability only, not ownership or anonymity.
const FLAG_BY_COUNTRY = Object.freeze({
  "США": "🇺🇸", "Франция": "🇫🇷", "Турция": "🇹🇷", "Польша": "🇵🇱",
  "Греция": "🇬🇷", "Италия": "🇮🇹", "Испания": "🇪🇸", "Великобритания": "🇬🇧",
  "Болгария": "🇧🇬", "Германия": "🇩🇪", "Нидерланды": "🇳🇱", "Румыния": "🇷🇴",
  "Украина": "🇺🇦", "Австрия": "🇦🇹", "Чехия": "🇨🇿",
});

function parseProxyList(source) {
  const countries = [];
  let current = null;
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(line)) {
      if (current) current.servers.push(line);
      continue;
    }
    if (current?.servers.length) countries.push(current);
    current = { name: line, flag: FLAG_BY_COUNTRY[line] || "🌐", servers: [] };
  }
  if (current?.servers.length) countries.push(current);
  return countries;
}

// Editable source list: src/proxy-list.txt; one country heading followed by IP:port lines.
export const HTTP_PROXY_COUNTRIES = parseProxyList(proxyListText);


export function findHttpProxy(endpoint) {
  const value = String(endpoint || "").trim();
  for (const country of HTTP_PROXY_COUNTRIES) {
    if (country.servers.includes(value)) return { country, endpoint: value };
  }
  return null;
}

export function isKnownHttpProxyEndpoint(endpoint) {
  return Boolean(findHttpProxy(endpoint));
}

export function parseHttpProxyEndpoint(endpoint) {
  const known = findHttpProxy(endpoint);
  if (!known) return null;
  const match = String(endpoint).match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/);
  if (!match) return null;
  const octets = match[1].split(".").map(Number);
  const port = Number(match[2]);
  if (octets.some((octet) => octet < 0 || octet > 255) || port < 1 || port > 65535) return null;
  return { hostname: match[1], port, country: known.country.name };
}

const TIMEOUT_MS = 2500;

export async function checkProxyTcp(endpoint) {
  const [hostname, portText] = String(endpoint).split(":");
  const port = Number(portText);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname || "") || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, ms: null, reason: "Некорректный адрес" };
  }

  let socket;
  let timeoutId;
  let reader;
  let writer;
  const started = Date.now();
  try {
    socket = connect({ hostname, port });
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS); }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;

    // Validate that the endpoint speaks HTTP proxy CONNECT, not just that its port is open.
    writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: close\r\n\r\n"
    ));
    writer.releaseLock();
    writer = null;

    reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    let response = "";
    while (!response.includes("\n") && response.length < 2048) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS); }),
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = null;
      if (chunk.done) break;
      response += decoder.decode(chunk.value, { stream: true });
    }

    const firstLine = response.split(/\r?\n/, 1)[0] || "";
    const statusMatch = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    const ms = Date.now() - started;
    if (status === 200) return { ok: true, ms, reason: "HTTP CONNECT работает", status };
    if (status === 407) return { ok: false, ms, reason: "Прокси требует авторизацию", status };
    if (status) return { ok: false, ms, reason: `HTTP-ответ ${status}; CONNECT не подтверждён`, status };
    return { ok: false, ms: null, reason: "Порт ответил, но HTTP-прокси не распознан" };
  } catch (error) {
    const message = String(error?.message || error || "").toLowerCase();
    return {
      ok: false,
      ms: null,
      reason: message.includes("timeout") ? `Тайм-аут ${TIMEOUT_MS} мс` : "Не удалось проверить HTTP CONNECT",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try { if (reader) reader.releaseLock(); } catch {}
    try { if (writer) writer.releaseLock(); } catch {}
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
