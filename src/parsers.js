import yaml from "js-yaml";

// ═══════════════════════════════════════════
//  УТИЛИТЫ
// ═══════════════════════════════════════════
export function safeBase64(data) {
  try {
    const clean = data.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean + "=".repeat((4 - clean.length % 4) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

export function extractHeaders(content) {
  const meta = {};
  for (const line of content.split("\n")) {
    if (line.startsWith("#")) {
      const m = line.match(/^#([a-z0-9-]+):\s*(.+)$/i);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  return meta;
}

// ═══════════════════════════════════════════
//  YAML PROXY → URI (Clash / Mihomo)
// ═══════════════════════════════════════════
export function proxyToUri(p) {
  if (!p || !p.type) return null;
  const t = p.type.toLowerCase();
  const name = p.name || "Server";
  
  if (t === "vless") {
    const params = new URLSearchParams();
    if (p.network) params.set("type", p.network);
    if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
    if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
    if (p["grpc-opts"]?.["grpc-service-name"]) params.set("serviceName", p["grpc-opts"]["grpc-service-name"]);
    if (p["reality-opts"]?.["public-key"]) params.set("pbk", p["reality-opts"]["public-key"]);
    if (p["reality-opts"]?.["short-id"]) params.set("sid", p["reality-opts"]["short-id"]);
    if (p.tls) params.set("security", "tls");
    else if (p["reality-opts"]) params.set("security", "reality");
    if (p.sni) params.set("sni", p.sni);
    if (p["client-fingerprint"]) params.set("fp", p["client-fingerprint"]);
    if (p.flow) params.set("flow", p.flow);
    const q = params.toString();
    return `vless://${p.uuid}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "vmess") {
    const v = {
      v: "2", ps: name, add: p.server, port: p.port, id: p.uuid,
      aid: p.alterId || 0, net: p.network || "tcp", type: "none",
      host: p["ws-opts"]?.headers?.Host || "", path: p["ws-opts"]?.path || "",
      tls: p.tls ? "tls" : "", sni: p.sni || "",
    };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  
  if (t === "trojan") {
    const params = new URLSearchParams();
    params.set("security", "tls");
    if (p.network) params.set("type", p.network);
    if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
    if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
    if (p.sni) params.set("sni", p.sni);
    const q = params.toString();
    return `trojan://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "ss" || t === "shadowsocks") {
    const ui = btoa(`${p.cipher}:${p.password}`);
    return `ss://${ui}@${p.server}:${p.port}#${encodeURIComponent(name)}`;
  }
  
  if (t === "hysteria" || t === "hysteria2") {
    const params = new URLSearchParams();
    if (p.sni) params.set("sni", p.sni);
    if (p["obfs-password"]) params.set("obfs-password", p["obfs-password"]);
    params.set("upmbps", String(p.up || 100).replace(/\D/g, "") || "100");
    params.set("downmbps", String(p.down || 100).replace(/\D/g, "") || "100");
    const q = params.toString();
    return `hysteria2://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "tuic") {
    const params = new URLSearchParams();
    if (p.sni) params.set("sni", p.sni);
    if (p.alpn) params.set("alpn", Array.isArray(p.alpn) ? p.alpn.join(",") : p.alpn);
    if (p["congestion-controller"]) params.set("congestion_control", p["congestion-controller"]);
    const q = params.toString();
    return `tuic://${p.uuid}:${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "wireguard" || t === "wg") {
    const params = new URLSearchParams();
    if (p["private-key"]) params.set("private_key", p["private-key"]);
    if (p["public-key"]) params.set("peer_public_key", p["public-key"]);
    if (p.ip) params.set("address", p.ip);
    const q = params.toString();
    return `wg://${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// ═══════════════════════════════════════════
//  XRAY OUTBOUND → URI
// ═══════════════════════════════════════════
export function xrayToUri(ob) {
  if (!ob || !ob.protocol) return null;
  const proto = ob.protocol.toLowerCase();
  const name = ob.tag || "Server";
  const ss = ob.streamSettings || {};
  
  if (proto === "vless" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0];
    const usr = srv.users?.[0];
    if (!usr) return null;
    const params = new URLSearchParams();
    if (ss.network) params.set("type", ss.network);
    if (ss.security) params.set("security", ss.security);
    if (ss.network === "ws") {
      if (ss.wsSettings?.path) params.set("path", ss.wsSettings.path);
      if (ss.wsSettings?.headers?.Host) params.set("host", ss.wsSettings.headers.Host);
    }
    if (ss.network === "grpc" && ss.grpcSettings?.serviceName) {
      params.set("serviceName", ss.grpcSettings.serviceName);
    }
    if (ss.realitySettings) {
      params.set("security", "reality");
      if (ss.realitySettings.serverName) params.set("sni", ss.realitySettings.serverName);
      if (ss.realitySettings.publicKey) params.set("pbk", ss.realitySettings.publicKey);
      if (ss.realitySettings.shortId) params.set("sid", ss.realitySettings.shortId);
    }
    if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
    if (usr.flow) params.set("flow", usr.flow);
    const q = params.toString();
    return `vless://${usr.id}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (proto === "vmess" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0];
    const usr = srv.users?.[0];
    if (!usr) return null;
    const v = {
      v: "2", ps: name, add: srv.address, port: srv.port, id: usr.id,
      aid: usr.alterId || 0, net: ss.network || "tcp", type: "none",
      host: ss.wsSettings?.headers?.Host || "", path: ss.wsSettings?.path || "",
      tls: ss.security === "tls" ? "tls" : "",
    };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  
  if (proto === "trojan" && ob.settings?.servers?.[0]) {
    const srv = ob.settings.servers[0];
    const params = new URLSearchParams();
    params.set("security", "tls");
    if (ss.network) params.set("type", ss.network);
    if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
    const q = params.toString();
    return `trojan://${srv.password}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (proto === "shadowsocks" && ob.settings?.servers?.[0]) {
    const srv = ob.settings.servers[0];
    const ui = btoa(`${srv.method}:${srv.password}`);
    return `ss://${ui}@${srv.address}:${srv.port}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// ═══════════════════════════════════════════
//  SING-BOX OUTBOUND → URI (Happ / Hiddify)
// ═══════════════════════════════════════════
export function singboxToUri(ob) {
  if (!ob || !ob.type || !ob.server || !ob.server_port) return null;
  const t = ob.type.toLowerCase();
  const name = ob.tag || "Server";
  const server = ob.server;
  const port = ob.server_port;
  
  if (t === "vless") {
    const params = new URLSearchParams();
    const tr = ob.transport || {};
    const tls = ob.tls || {};
    if (tr.type) params.set("type", tr.type);
    if (tr.type === "ws") {
      if (tr.path) params.set("path", tr.path);
      if (tr.headers?.Host) params.set("host", tr.headers.Host);
    }
    if (tr.type === "grpc" && tr.service_name) params.set("serviceName", tr.service_name);
    if (tls.enabled) {
      params.set("security", tls.reality?.enabled ? "reality" : "tls");
      if (tls.server_name) params.set("sni", tls.server_name);
      if (tls.reality?.public_key) params.set("pbk", tls.reality.public_key);
      if (tls.reality?.short_id) params.set("sid", tls.reality.short_id);
      if (tls.utls?.fingerprint) params.set("fp", tls.utls.fingerprint);
    }
    if (ob.flow) params.set("flow", ob.flow);
    const q = params.toString();
    return `vless://${ob.uuid}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "vmess") {
    const tr = ob.transport || {};
    const tls = ob.tls || {};
    const v = {
      v: "2", ps: name, add: server, port, id: ob.uuid,
      aid: ob.alter_id || 0, net: tr.type || "tcp", type: "none",
      host: tr.headers?.Host || "", path: tr.path || "",
      tls: tls.enabled ? "tls" : "", sni: tls.server_name || "",
    };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  
  if (t === "trojan") {
    const params = new URLSearchParams();
    const tls = ob.tls || {};
    params.set("security", "tls");
    if (ob.transport?.type) params.set("type", ob.transport.type);
    if (ob.transport?.path) params.set("path", ob.transport.path);
    if (ob.transport?.headers?.Host) params.set("host", ob.transport.headers.Host);
    if (tls.server_name) params.set("sni", tls.server_name);
    const q = params.toString();
    return `trojan://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "shadowsocks") {
    const ui = btoa(`${ob.method}:${ob.password}`);
    return `ss://${ui}@${server}:${port}#${encodeURIComponent(name)}`;
  }
  
  if (t === "hysteria2" || t === "hysteria") {
    const params = new URLSearchParams();
    if (ob.tls?.server_name) params.set("sni", ob.tls.server_name);
    if (ob.obfs?.password) params.set("obfs-password", ob.obfs.password);
    const q = params.toString();
    return `hysteria2://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "tuic") {
    const params = new URLSearchParams();
    if (ob.tls?.server_name) params.set("sni", ob.tls.server_name);
    if (ob.congestion_control) params.set("congestion_control", ob.congestion_control);
    const q = params.toString();
    return `tuic://${ob.uuid}:${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

// ═══════════════════════════════════════════
//  ПАРСЕРЫ ФОРМАТОВ
// ═══════════════════════════════════════════
export function parseVlessList(content) {
  const uris = [];
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (l && !l.startsWith("#") && /^[a-z0-9]+:\/\//i.test(l)) {
      uris.push(l);
    }
  }
  return { ok: true, uris, metadata: extractHeaders(content) };
}

export function parseBase64(content) {
  const decoded = safeBase64(content.replace(/\s/g, ""));
  if (!decoded) return { ok: false, error: "Invalid base64" };
  return parseVlessList(decoded);
}

export function parseYaml(content) {
  try {
    const cfg = yaml.load(content);
    const uris = [];
    const proxies = cfg?.proxies || [];
    for (const p of proxies) {
      const uri = proxyToUri(p);
      if (uri) uris.push(uri);
    }
    return {
      ok: true,
      uris,
      metadata: extractHeaders(content),
      title: cfg?.["profile-title"] || cfg?.name,
      interval: cfg?.["profile-update-interval"],
    };
  } catch (e) {
    return { ok: false, error: `YAML: ${e.message}` };
  }
}

export function parseJson(content) {
  try {
    const data = JSON.parse(content);
    const uris = [];
    
    const tryConvert = (ob) => {
      let uri = singboxToUri(ob);
      if (!uri) uri = xrayToUri(ob);
      if (!uri) uri = proxyToUri(ob);
      return uri;
    };

    if (Array.isArray(data?.outbounds)) {
      const skip = ["direct", "block", "dns", "selector", "urltest", "fallback"];
      for (const ob of data.outbounds) {
        if (skip.includes(ob?.type) || skip.includes(ob?.protocol)) continue;
        const uri = tryConvert(ob);
        if (uri) uris.push(uri);
      }
    }

    if (Array.isArray(data?.configs)) {
      for (const c of data.configs) {
        if (typeof c === "string") uris.push(c);
        else if (c?.url) uris.push(c.url);
        else if (c?.config) uris.push(c.config);
      }
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "string" && item.includes("://")) {
          uris.push(item);
        } else if (item?.type) {
          const uri = tryConvert(item);
          if (uri) uris.push(uri);
        } else if (Array.isArray(item?.outbounds)) {
          const skip = ["direct", "block", "dns", "selector", "urltest", "fallback"];
          for (const ob of item.outbounds) {
            if (skip.includes(ob?.type) || skip.includes(ob?.protocol)) continue;
            const uri = tryConvert(ob);
            if (uri) uris.push(uri);
          }
        }
      }
    }

    if (data?.type && !Array.isArray(data)) {
      const uri = tryConvert(data);
      if (uri) uris.push(uri);
    }

    if (uris.length === 0) {
      return { ok: false, error: "JSON не содержит распознаваемых конфигов" };
    }

    const uniqueUris = [...new Set(uris)];
    return { ok: true, uris: uniqueUris, metadata: {} };
  } catch (e) {
    return { ok: false, error: `JSON: ${e.message}` };
  }
}

export function parseCrypt(content) {
  const m = content.match(/^crypt[45]:\/\/(.+)$/i);
  if (!m) return { ok: false, error: "Некорректный crypt формат" };
  const decoded = safeBase64(m[1]);
  if (decoded && decoded.includes("://")) {
    return parseVlessList(decoded);
  }
  return {
    ok: false,
    error: `⚠️ <b>crypt5/crypt4</b> — зашифрованный формат Happ/Hiddify\n\nТребуется AES-ключ для дешифровки.\n\n💡 <b>Решение:</b> открой ссылку в Happ или Hiddify → экспортируй как обычную vless подписку → отправь мне снова.`
  };
}

// ═══════════════════════════════════════════
// HTML → сбор конфигов со страницы
// ═══════════════════════════════════════════

const PROXY_SCHEMES = [
  "vless", "vmess", "trojan", "ss", "ssr",
  "hysteria", "hysteria2", "hy2", "tuic", "wg", "wireguard",
  "socks", "socks5", "http",
];

function buildProxyUriRegex() {
  const schemes = PROXY_SCHEMES.join("|");
  // 🔥 ИСПРАВЛЕНО: убрана лишняя закрывающая скобка ']', которая ломала парсинг
  return new RegExp(`(?:${schemes})://[^\\s"'<>&]+`, "gi");
}

function buildSubLinkRegex() {
  return /https?:\/\/[^\s"'<>\)\]]+/gi;
}

const SUB_LINK_IGNORE = /\.(png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|map)(\?|#|$)/i;
const SUB_LINK_IGNORE_HOSTS = /(github\.com\/(?!.*\/raw\/)|githubusercontent\.com\/.*\.md$|twitter\.com|t\.me\/(?!.*[?&#]|.*\/joinchat)|youtube\.com|vk\.com|facebook\.com|instagram\.com)/i;
const SUB_LINK_LIKELY = /(sub|config|clash|singbox|sing-box|v2ray|xray|proxy|nodes?|link|raw\.githubusercontent|\/api\/|token=|\.ya?ml($|\?)|\.json($|\?)|\.txt($|\?))/i;

function stripHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractCodeBlocks(html) {
  const blocks = [];
  const re = /<(pre|code|textarea)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtmlEntities(m[2].replace(/<[^>]+>/g, ""));
    if (text.trim()) blocks.push(text);
  }
  return blocks;
}

export function parseHtml(html, pageUrl) {
  if (!html || typeof html !== "string") {
    return { ok: false, error: "Пустой HTML" };
  }

  const uris = new Set();
  const subLinks = new Set();

  const uriRe = buildProxyUriRegex();
  const linkRe = buildSubLinkRegex();

  const cleanedHtml = stripHtmlEntities(html);
  for (const match of cleanedHtml.matchAll(uriRe)) {
    uris.add(match[0].replace(/[.,;]+$/, ""));
  }

  for (const block of extractCodeBlocks(html)) {
    const listResult = parseVlessList(block);
    if (listResult.ok) {
      for (const u of listResult.uris) uris.add(u);
    }
    if (!/:\/\//.test(block)) {
      const b64Result = parseBase64(block);
      if (b64Result.ok) {
        for (const u of b64Result.uris) uris.add(u);
      }
    }
  }

  for (const match of cleanedHtml.matchAll(linkRe)) {
    const url = match[0].replace(/[.,;]+$/, "");
    if (SUB_LINK_IGNORE.test(url)) continue;
    if (SUB_LINK_IGNORE_HOSTS.test(url)) continue;
    if (SUB_LINK_LIKELY.test(url) || /\/raw\//.test(url)) {
      subLinks.add(url);
    }
  }

  const normalizedSubLinks = [...subLinks].map((u) => {
    const blobMatch = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    if (blobMatch) {
      return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
    }
    return u;
  });

  if (uris.size === 0 && normalizedSubLinks.length === 0) {
    return { ok: false, error: "На странице не найдено конфигов или ссылок на подписки" };
  }

  return {
    ok: true,
    uris: [...uris],
    subLinks: normalizedSubLinks,
    metadata: extractHeaders(html),
  };
}

export async function parseUrl(url, fetcher, depth = 0) {
  let content;
  try {
    content = await fetcher(url);
  } catch (e) {
    return { ok: false, error: `Не удалось скачать: ${e.message}` };
  }

  const trimmed = content.trim();
  const looksLikeHtml = /^<!doctype html|^<html[\s>]/i.test(trimmed) || /<\/html>/i.test(trimmed);

  if (looksLikeHtml) {
    const htmlResult = parseHtml(content, url);
    if (!htmlResult.ok) return htmlResult;

    let allUris = [...htmlResult.uris];

    if (depth === 0) {
      for (const sub of htmlResult.subLinks.slice(0, 10)) {
        const nested = await parseUrl(sub, fetcher, depth + 1);
        if (nested.ok) allUris.push(...nested.uris);
      }
    }

    const uniqueUris = [...new Set(allUris)];
    if (uniqueUris.length === 0) {
      return { ok: false, error: "Конфиги не найдены ни на странице, ни по вложенным ссылкам" };
    }
    return { ok: true, uris: uniqueUris, metadata: htmlResult.metadata };
  }

  if (/^crypt[45]:\/\//i.test(trimmed)) return parseCrypt(trimmed);
  if (/^[a-z0-9]+:\/\//i.test(trimmed) || trimmed.split("\n").some((l) => /^[a-z0-9]+:\/\//i.test(l.trim()))) {
    return parseVlessList(trimmed);
  }
  try {
    JSON.parse(trimmed);
    return parseJson(trimmed);
  } catch {}
  
  if (/^proxies:|^proxy-groups:/m.test(trimmed)) {
    return parseYaml(trimmed);
  }
  const b64 = parseBase64(trimmed);
  if (b64.ok) return b64;

  return { ok: false, error: "Неизвестный формат содержимого по ссылке" };
        }
