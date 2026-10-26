const SUPPORTED_PROTOCOLS = new Set(["vless", "vmess", "trojan", "ss"]);

function decodeBase64(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return atob(padded);
}

function decodeBase64Utf8(value) {
  const binary = decodeBase64(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeDecode(value) {
  try { return decodeURIComponent(value || ""); } catch { return value || ""; }
}

function getRemark(uri, url) {
  const hashAt = uri.lastIndexOf("#");
  if (hashAt >= 0) return safeDecode(uri.slice(hashAt + 1)).trim();
  return url.hostname || "VPN server";
}

function transportSettings(network, params, hostFallback = "") {
  const type = String(network || "tcp").toLowerCase();
  const path = params.get("path") || params.get("serviceName") || "";
  const host = params.get("host") || hostFallback || "";
  if (type === "ws") {
    const wsSettings = {};
    if (path) wsSettings.path = path;
    if (host) wsSettings.headers = { Host: host };
    return { network: "ws", wsSettings };
  }
  if (type === "grpc") {
    const grpcSettings = { serviceName: params.get("serviceName") || path };
    const mode = params.get("mode");
    if (mode) grpcSettings.multiMode = mode.toLowerCase() === "multi";
    return { network: "grpc", grpcSettings };
  }
  if (type === "http" || type === "h2") {
    const httpSettings = { path: path || "/", host: host ? host.split(",").map((v) => v.trim()).filter(Boolean) : [] };
    return { network: "http", httpSettings };
  }
  if (type === "xhttp") {
    const xhttpSettings = {};
    if (path) xhttpSettings.path = path;
    if (host) xhttpSettings.host = host;
    const mode = params.get("mode");
    if (mode) xhttpSettings.mode = mode;
    return { network: "xhttp", xhttpSettings };
  }
  if (type === "httpupgrade") {
    const httpupgradeSettings = {};
    if (path) httpupgradeSettings.path = path;
    if (host) httpupgradeSettings.host = host;
    return { network: "httpupgrade", httpupgradeSettings };
  }
  if (type === "kcp" || type === "mkcp") {
    const kcpSettings = { seed: params.get("seed") || "" };
    const headerType = params.get("headerType") || "none";
    kcpSettings.header = { type: headerType };
    return { network: "kcp", kcpSettings };
  }
  const headerType = params.get("headerType") || params.get("header-type") || "none";
  return { network: "tcp", tcpSettings: { header: { type: headerType } } };
}

function tlsSettings(params, host, forced = "") {
  const security = String(forced || params.get("security") || "none").toLowerCase();
  if (security === "reality") {
    const realitySettings = {
      show: false,
      fingerprint: params.get("fp") || "chrome",
      serverName: params.get("sni") || params.get("serverName") || host,
      publicKey: params.get("pbk") || params.get("publicKey") || "",
      shortId: params.get("sid") || params.get("shortId") || "",
    };
    const spiderX = params.get("spx") || params.get("spiderX");
    if (spiderX) realitySettings.spiderX = spiderX;
    return { security: "reality", realitySettings };
  }
  if (security === "tls" || security === "https") {
    const tls = {
      serverName: params.get("sni") || params.get("serverName") || host,
      allowInsecure: ["1", "true"].includes(String(params.get("allowInsecure") || params.get("insecure") || "").toLowerCase()),
    };
    const fp = params.get("fp") || params.get("fingerprint");
    if (fp) tls.fingerprint = fp;
    const alpn = params.get("alpn");
    if (alpn) tls.alpn = alpn.split(",").map((v) => v.trim()).filter(Boolean);
    return { security: "tls", tlsSettings: tls };
  }
  return { security: "none" };
}

function parseVless(uri) {
  const url = new URL(uri);
  const params = url.searchParams;
  const id = safeDecode(url.username);
  if (!id || !url.hostname || !url.port) throw new Error("VLESS URI has no UUID, host or port");

  // Use the current simplified Xray VLESS outbound schema instead of legacy settings.vnext.
  const settings = {
    address: url.hostname,
    port: Number(url.port),
    id,
    encryption: params.get("encryption") || "none",
  };
  const flow = params.get("flow");
  if (flow) settings.flow = flow;

  const outbound = {
    tag: "proxy",
    protocol: "vless",
    settings,
    streamSettings: {
      ...transportSettings(params.get("type") || "tcp", params, params.get("host") || ""),
      ...tlsSettings(params, url.hostname),
    },
  };
  return outbound;
}

function parseVmess(uri) {
  const payload = uri.slice(uri.indexOf("://") + 3).split("#")[0].trim();
  let data;
  try { data = JSON.parse(decodeBase64Utf8(payload)); }
  catch (error) { throw new Error(`Invalid VMess payload: ${error.message}`); }
  const host = String(data.add || data.address || "");
  const port = Number(data.port);
  const id = String(data.id || data.uuid || "");
  if (!host || !port || !id) throw new Error("VMess URI has no UUID, host or port");
  const security = String(data.tls || "").toLowerCase() === "tls" || data.tls === "1" ? "tls" : "none";
  const user = { id, alterId: Number(data.aid || 0), security: String(data.scy || "auto") };
  const outbound = {
    tag: "proxy",
    protocol: "vmess",
    settings: { vnext: [{ address: host, port, users: [user] }] },
    streamSettings: {
      ...transportSettings(data.net || "tcp", new URLSearchParams({
        type: String(data.net || "tcp"),
        host: String(data.host || ""),
        path: String(data.path || ""),
        serviceName: String(data.path || ""),
        mode: String(data.mode || ""),
      }), String(data.host || "")),
      security,
    },
  };
  if (security === "tls") {
    outbound.streamSettings.tlsSettings = {
      serverName: String(data.sni || data.host || host),
      allowInsecure: data.allowInsecure === true || String(data.allowInsecure) === "1",
    };
    if (data.fp) outbound.streamSettings.tlsSettings.fingerprint = data.fp;
    if (data.alpn) outbound.streamSettings.tlsSettings.alpn = String(data.alpn).split(",").map((v) => v.trim()).filter(Boolean);
  }
  return outbound;
}

function parseTrojan(uri) {
  const url = new URL(uri);
  const params = url.searchParams;
  const password = safeDecode(url.password || url.username);
  if (!password || !url.hostname || !url.port) throw new Error("Trojan URI has no password, host or port");
  const outbound = {
    tag: "proxy",
    protocol: "trojan",
    settings: { servers: [{ address: url.hostname, port: Number(url.port), password }] },
    streamSettings: {
      ...transportSettings(params.get("type") || "tcp", params, params.get("host") || ""),
      ...tlsSettings(params, url.hostname, params.get("security") || "tls"),
    },
  };
  return outbound;
}

function parseShadowsocks(uri) {
  let withoutScheme = uri.slice(uri.indexOf("://") + 3).split("#")[0];
  let at = withoutScheme.lastIndexOf("@");
  // Legacy Shadowsocks URI encodes the entire method:password@host:port tuple.
  if (at < 0) {
    try {
      const decoded = decodeBase64Utf8(withoutScheme);
      if (decoded.includes("@")) {
        withoutScheme = decoded;
        at = withoutScheme.lastIndexOf("@");
      }
    } catch {}
  }
  if (at < 0) throw new Error("Shadowsocks URI must contain credentials and host");
  let credentials = withoutScheme.slice(0, at);
  const server = withoutScheme.slice(at + 1);
  if (!credentials.includes(":")) {
    try { credentials = decodeBase64Utf8(credentials); } catch {}
  }
  const sep = credentials.indexOf(":");
  if (sep < 1) throw new Error("Shadowsocks URI has invalid method/password");
  const method = safeDecode(credentials.slice(0, sep));
  const password = safeDecode(credentials.slice(sep + 1));
  let hostPort;
  try { hostPort = new URL(`ss://${server}`); }
  catch { throw new Error("Shadowsocks URI has invalid host or port"); }
  if (!hostPort.hostname || !hostPort.port) throw new Error("Shadowsocks URI has no host or port");
  return {
    tag: "proxy",
    protocol: "shadowsocks",
    settings: { servers: [{ address: hostPort.hostname, port: Number(hostPort.port), method, password }] },
  };
}

function outboundFromUri(uri) {
  const scheme = String(uri).slice(0, String(uri).indexOf("://")).toLowerCase();
  if (!SUPPORTED_PROTOCOLS.has(scheme)) return { unsupported: scheme || "unknown" };
  if (scheme === "vless") return { outbound: parseVless(uri) };
  if (scheme === "vmess") return { outbound: parseVmess(uri) };
  if (scheme === "trojan") return { outbound: parseTrojan(uri) };
  if (scheme === "ss") return { outbound: parseShadowsocks(uri) };
  return { unsupported: scheme };
}

export function buildHappJsonSubscription(content, httpProxyEndpoint = null) {
  const lines = String(content || "").split(/\r?\n/);
  const metadata = {};
  const uris = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      const match = trimmed.match(/^#([a-z0-9-]+):\s*(.*)$/i);
      if (match) metadata[match[1].toLowerCase()] = match[2];
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) uris.push(trimmed);
  }

  const configs = [];
  const unsupported = [];
  const errors = [];
  for (const uri of uris) {
    try {
      const parsed = outboundFromUri(uri);
      if (parsed.unsupported) {
        unsupported.push({ protocol: parsed.unsupported, remark: uri.split("#").slice(1).join("#") });
        continue;
      }
      const hashAt = uri.lastIndexOf("#");
      const remarks = hashAt >= 0 ? safeDecode(uri.slice(hashAt + 1)) : new URL(uri).hostname;
      const outbounds = [parsed.outbound];
      if (httpProxyEndpoint) {
        const match = String(httpProxyEndpoint).match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/);
        if (!match) throw new Error("Invalid HTTP proxy endpoint");
        const octets = match[1].split(".").map(Number);
        const port = Number(match[2]);
        if (octets.some((octet) => octet < 0 || octet > 255) || port < 1 || port > 65535) {
          throw new Error("Invalid HTTP proxy endpoint");
        }
        // Xray uses this outbound only as the TCP dialer for the VPN node.
        // The HTTP proxy itself does not carry UDP; unsupported UDP-dependent nodes can fail.
        parsed.outbound.streamSettings = parsed.outbound.streamSettings || {};
        parsed.outbound.streamSettings.sockopt = {
          ...(parsed.outbound.streamSettings.sockopt || {}),
          dialerProxy: "oceania-http-proxy",
        };
        outbounds.push({
          tag: "oceania-http-proxy",
          protocol: "http",
          settings: { address: match[1], port },
        });
      }
      outbounds.push({ tag: "direct", protocol: "freedom" });
      configs.push({
        remarks: String(remarks || "VPN server").slice(0, 100),
        dns: { servers: ["1.1.1.1", "1.0.0.1"], queryStrategy: "UseIP" },
        inbounds: [],
        outbounds,
        routing: {},
        burstObservatory: {},
      });
    } catch (error) {
      errors.push({ message: error?.message || String(error) });
    }
  }

  return { body: JSON.stringify(configs), configs, unsupported, errors, metadata, totalUris: uris.length };
}
