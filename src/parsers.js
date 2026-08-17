import yaml from "js-yaml";

// === ПАРСЕРЫ КОНФИГОВ В URI ===

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
    params.set("upmbps", p.up || "100");
    params.set("downmbps", p.down || "100");
    const q = params.toString();
    return `hysteria2://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  if (t === "tuic") {
    const params = new URLSearchParams();
    if (p.sni) params.set("sni", p.sni);
    if (p["alpn"]) params.set("alpn", Array.isArray(p.alpn) ? p.alpn.join(",") : p.alpn);
    const q = params.toString();
    return `tuic://${p.uuid}:${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
  }
  
  return null;
}

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

// === ПАРСЕРЫ ФОРМАТОВ ===

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
    
    if (data.outbounds && Array.isArray(data.outbounds)) {
      for (const ob of data.outbounds) {
        const uri = xrayToUri(ob);
        if (uri) uris.push(uri);
      }
    }
    
    if (data.configs && Array.isArray(data.configs)) {
      for (const c of data.configs) {
        if (typeof c === "string") uris.push(c);
        else if (c?.url) uris.push(c.url);
        else if (c?.config) uris.push(c.config);
      }
    }
    
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "string" && item.includes("://")) uris.push(item);
        else if (item?.type) {
          const uri = proxyToUri(item);
          if (uri) uris.push(uri);
        }
      }
    }
    
    if (data?.type && !Array.isArray(data)) {
      const uri = proxyToUri(data);
      if (uri) uris.push(uri);
    }
    
    if (uris.length === 0) return { ok: false, error: "JSON не содержит конфигов" };
    return { ok: true, uris, metadata: {} };
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
    error: `⚠️ <b>crypt5/crypt4</b> — зашифрованный формат Happ/Hiddify\n\n` +
           `Требуется AES-ключ для дешифровки.\n\n` +
           `💡 <b>Решение:</b> открой ссылку в Happ или Hiddify → экспортируй как обычную vless подписку → отправь мне снова.`
  };
                                                   }
