import yaml from "js-yaml";
import { decryptHappCrypt, parseCryptMode } from "./crypt.js";

// ═══════════════════════════════════════════
// УТИЛИТЫ
// ═══════════════════════════════════════════
export function safeBase64(data) {
  try {
    const clean = data.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean + "=".repeat((4 - clean.length % 4) % 4);
    return atob(padded);
  } catch { return null; }
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
    if (p.tls) params.set("security", "tls"); else if (p["reality-opts"]) params.set("security", "reality");
    if (p.sni) params.set("sni", p.sni);
    if (p["client-fingerprint"]) params.set("fp", p["client-fingerprint"]);
    if (p.flow) params.set("flow", p.flow);
    const q = params.toString();
    return `vless://${p.uuid}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (t === "vmess") {
    const v = { v: "2", ps: name, add: p.server, port: p.port, id: p.uuid, aid: p.alterId || 0, net: p.network || "tcp", type: "none", host: p["ws-opts"]?.headers?.Host || "", path: p["ws-opts"]?.path || "", tls: p.tls ? "tls" : "", sni: p.sni || "" };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  if (t === "trojan") {
    const params = new URLSearchParams(); params.set("security", "tls");
    if (p.network) params.set("type", p.network); if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path); if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host); if (p.sni) params.set("sni", p.sni);
    const q = params.toString(); return `trojan://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (t === "ss" || t === "shadowsocks") return `ss://${btoa(`${p.cipher}:${p.password}`)}@${p.server}:${p.port}#${encodeURIComponent(name)}`;
  if (t === "hysteria" || t === "hysteria2") {
    const params = new URLSearchParams(); if (p.sni) params.set("sni", p.sni); if (p["obfs-password"]) params.set("obfs-password", p["obfs-password"]); params.set("upmbps", String(p.up || 100).replace(/\D/g, "") || "100"); params.set("downmbps", String(p.down || 100).replace(/\D/g, "") || "100");
    const q = params.toString(); return `hysteria2://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (t === "tuic") {
    const params = new URLSearchParams(); if (p.sni) params.set("sni", p.sni); if (p.alpn) params.set("alpn", Array.isArray(p.alpn) ? p.alpn.join(",") : p.alpn); if (p["congestion-controller"]) params.set("congestion_control", p["congestion-controller"]);
    const q = params.toString(); return `tuic://${p.uuid}:${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (t === "wireguard" || t === "wg") {
    const params = new URLSearchParams(); if (p["private-key"]) params.set("private_key", p["private-key"]); if (p["public-key"]) params.set("peer_public_key", p["public-key"]); if (p.ip) params.set("address", p.ip);
    const q = params.toString(); return `wg://${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  return null;
}

export function xrayToUri(ob) {
  if (!ob || !ob.protocol) return null;
  const proto = ob.protocol.toLowerCase(), name = ob.tag || "Server", ss = ob.streamSettings || {};
  if (proto === "vless" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0], usr = srv.users?.[0]; if (!usr) return null;
    const params = new URLSearchParams(); if (ss.network) params.set("type", ss.network); if (ss.security) params.set("security", ss.security);
    if (ss.network === "ws") { if (ss.wsSettings?.path) params.set("path", ss.wsSettings.path); if (ss.wsSettings?.headers?.Host) params.set("host", ss.wsSettings.headers.Host); }
    if (ss.network === "grpc" && ss.grpcSettings?.serviceName) params.set("serviceName", ss.grpcSettings.serviceName);
    if (ss.realitySettings) { params.set("security", "reality"); if (ss.realitySettings.serverName) params.set("sni", ss.realitySettings.serverName); if (ss.realitySettings.publicKey) params.set("pbk", ss.realitySettings.publicKey); if (ss.realitySettings.shortId) params.set("sid", ss.realitySettings.shortId); if (ss.realitySettings.fingerprint) params.set("fp", ss.realitySettings.fingerprint); }
    if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName); if (ss.tlsSettings?.fingerprint) params.set("fp", ss.tlsSettings.fingerprint); if (usr.flow) params.set("flow", usr.flow);
    const q = params.toString(); return `vless://${usr.id}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (proto === "vmess" && ob.settings?.vnext?.[0]) {
    const srv = ob.settings.vnext[0], usr = srv.users?.[0]; if (!usr) return null;
    const v = { v: "2", ps: name, add: srv.address, port: srv.port, id: usr.id, aid: usr.alterId || 0, net: ss.network || "tcp", type: "none", host: ss.wsSettings?.headers?.Host || "", path: ss.wsSettings?.path || "", tls: ss.security === "tls" ? "tls" : "" };
    return `vmess://${btoa(JSON.stringify(v))}`;
  }
  if (proto === "trojan" && ob.settings?.servers?.[0]) {
    const srv = ob.settings.servers[0], params = new URLSearchParams(); params.set("security", "tls"); if (ss.network) params.set("type", ss.network); if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName); if (ss.tlsSettings?.fingerprint) params.set("fp", ss.tlsSettings.fingerprint);
    const q = params.toString(); return `trojan://${srv.password}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (proto === "shadowsocks" && ob.settings?.servers?.[0]) { const srv = ob.settings.servers[0]; return `ss://${btoa(`${srv.method}:${srv.password}`)}@${srv.address}:${srv.port}#${encodeURIComponent(name)}`; }
  return null;
}

export function singboxToUri(ob) {
  if (!ob || !ob.type || !ob.server || !ob.server_port) return null;
  const t = ob.type.toLowerCase(), name = ob.tag || "Server", server = ob.server, port = ob.server_port;
  if (t === "vless") {
    const params = new URLSearchParams(), tr = ob.transport || {}, tls = ob.tls || {};
    if (tr.type) params.set("type", tr.type); if (tr.type === "ws") { if (tr.path) params.set("path", tr.path); if (tr.headers?.Host) params.set("host", tr.headers.Host); }
    if (tr.type === "grpc" && tr.service_name) params.set("serviceName", tr.service_name);
    if (tls.enabled) { params.set("security", tls.reality?.enabled ? "reality" : "tls"); if (tls.server_name) params.set("sni", tls.server_name); if (tls.reality?.public_key) params.set("pbk", tls.reality.public_key); if (tls.reality?.short_id) params.set("sid", tls.reality.short_id); if (tls.utls?.fingerprint) params.set("fp", tls.utls.fingerprint); }
    if (ob.flow) params.set("flow", ob.flow); const q = params.toString(); return `vless://${ob.uuid}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  if (t === "vmess") { const tr = ob.transport || {}, tls = ob.tls || {}; const v = { v: "2", ps: name, add: server, port, id: ob.uuid, aid: ob.alter_id || 0, net: tr.type || "tcp", type: "none", host: tr.headers?.Host || "", path: tr.path || "", tls: tls.enabled ? "tls" : "", sni: tls.server_name || "" }; return `vmess://${btoa(JSON.stringify(v))}`; }
  if (t === "trojan") { const params = new URLSearchParams(), tls = ob.tls || {}; params.set("security", "tls"); if (ob.transport?.type) params.set("type", ob.transport.type); if (ob.transport?.path) params.set("path", ob.transport.path); if (ob.transport?.headers?.Host) params.set("host", ob.transport.headers.Host); if (tls.server_name) params.set("sni", tls.server_name); if (tls.utls?.fingerprint) params.set("fp", tls.utls.fingerprint); const q = params.toString(); return `trojan://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`; }
  if (t === "shadowsocks") return `ss://${btoa(`${ob.method}:${ob.password}`)}@${server}:${port}#${encodeURIComponent(name)}`;
  if (t === "hysteria2" || t === "hysteria") { const params = new URLSearchParams(); if (ob.tls?.server_name) params.set("sni", ob.tls.server_name); if (ob.obfs?.password) params.set("obfs-password", ob.obfs.password); const q = params.toString(); return `hysteria2://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`; }
  if (t === "tuic") { const params = new URLSearchParams(); if (ob.tls?.server_name) params.set("sni", ob.tls.server_name); if (ob.congestion_control) params.set("congestion_control", ob.congestion_control); const q = params.toString(); return `tuic://${ob.uuid}:${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`; }
  return null;
}

export function parseVlessList(content) {
  const uris = [];
  for (const line of content.split("\n")) { const l = line.trim(); if (l && !l.startsWith("#") && /^[a-z0-9]+:\/\//i.test(l)) uris.push(l); }
  return { ok: true, uris, metadata: extractHeaders(content) };
}

export function parseBase64(content) {
  const raw = String(content ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) return { ok: false, error: "Пустая подписка" };

  // Subscription servers sometimes return URL-encoded/base64url data,
  // wrapped in whitespace or with a data: prefix. Try the common variants
  // before reporting an invalid Base64 payload.
  const candidates = [];
  const add = value => {
    const v = String(value ?? "").trim();
    if (v && !candidates.includes(v)) candidates.push(v);
  };

  add(raw);
  try { add(decodeURIComponent(raw)); } catch {}

  for (const value of [...candidates]) {
    if (/^data:[^,]+,/i.test(value)) add(value.replace(/^data:[^,]+,/i, ""));
    add(value.replace(/[\s\r\n]+/g, ""));
    add(value.replace(/[\s\r\n]+/g, "").replace(/-/g, "+").replace(/_/g, "/"));
  }

  for (const value of candidates) {
    const decoded = safeBase64(value);
    if (!decoded) continue;

    const text = decoded.replace(/^\uFEFF/, "").trim();
    if (!text) continue;

    if (/^(?:https?|happ|incy|v2raytun):\/\//i.test(text)) {
      return parseVlessList(text);
    }
    if (/^(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(text)) {
      return parseVlessList(text);
    }
    if (/^\s*[\[{]/.test(text)) {
      const json = parseJson(text);
      if (json.ok) return json;
    }
    if (/^(?:proxies|proxy-groups|mixed-port|port|mode)\s*:/im.test(text)) {
      const yamlResult = parseYaml(text);
      if (yamlResult.ok) return yamlResult;
    }

    const parsed = parseVlessList(text);
    if (parsed.uris.length) return parsed;
  }

  return { ok: false, error: "Invalid base64" };
}

export function parseYaml(content) {
  try { const cfg = yaml.load(content), uris = []; for (const p of cfg?.proxies || []) { const uri = proxyToUri(p); if (uri) uris.push(uri); } return { ok: true, uris, metadata: extractHeaders(content), title: cfg?.["profile-title"] || cfg?.name, interval: cfg?.["profile-update-interval"] }; }
  catch (e) { return { ok: false, error: `YAML: ${e.message}` }; }
}

export function parseJson(content) {
  try {
    const data = JSON.parse(content), uris = [];
    const tryConvert = ob => singboxToUri(ob) || xrayToUri(ob) || proxyToUri(ob);
    if (Array.isArray(data?.outbounds)) { const skip = ["direct", "block", "dns", "selector", "urltest", "loadbalance"]; for (const ob of data.outbounds) { if (!skip.includes(String(ob?.type || "").toLowerCase())) { const uri = tryConvert(ob); if (uri) uris.push(uri); } } }
    if (Array.isArray(data?.proxies)) for (const p of data.proxies) { const uri = tryConvert(p); if (uri) uris.push(uri); }
    if (Array.isArray(data)) for (const p of data) { const uri = tryConvert(p); if (uri) uris.push(uri); }
    return { ok: true, uris, metadata: data?.metadata || extractHeaders(content), title: data?.name || data?.title };
  } catch (e) { return { ok: false, error: `JSON: ${e.message}` }; }
}

export async function parseCrypt(content) {
  const parsed = parseCryptMode(content);
  if (!parsed) return { ok: false, error: "Некорректный crypt формат" };
  try {
    const decrypted = await decryptHappCrypt(content);
    const value = decrypted.trim();
    if (!value) return { ok: false, error: "Crypt расшифрован, но результат пуст" };

    if (/^happ:\/\/crypt(?:[2-5])?\//i.test(value)) return parseCrypt(value);
    if (/^https?:\/\//i.test(value)) return { ok: true, uris: [value], metadata: {}, wrapper: true };
    if (/^(?:happ|incy|v2raytun):\/\/add\//i.test(value)) return { ok: true, uris: [value], metadata: {}, wrapper: true };
    if (/(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(value)) return parseVlessList(value);
    if (/^\s*[\[{]/.test(value)) { const json = parseJson(value); if (json.ok) return json; }
    if (/^(?:proxies|proxy-groups|mixed-port|port|mode)\s*:/im.test(value)) { const yamlResult = parseYaml(value); if (yamlResult.ok) return yamlResult; }
    const decoded = safeBase64(value.replace(/\s/g, ""));
    if (decoded && decoded !== value) {
      if (/^https?:\/\//i.test(decoded.trim())) return { ok: true, uris: [decoded.trim()], metadata: {}, wrapper: true };
      if (/^happ:\/\/crypt(?:[2-5])?\//i.test(decoded.trim())) return parseCrypt(decoded.trim());
      if (/(?:vless|vmess|trojan|ss|hysteria2?|tuic|wireguard|wg):\/\//i.test(decoded)) return parseVlessList(decoded);
    }
    return { ok: true, uris: [value], metadata: {} };
  } catch (e) {
    return { ok: false, error: `crypt${parsed.mode === 0 ? "" : parsed.mode + 1}: ${e?.message || "расшифровка не удалась"}` };
  }
}
