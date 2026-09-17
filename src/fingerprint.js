// Lightweight client fingerprinting for /sub.
// This is intentionally signal-based: every individual header can be forged.

const MAX_HISTORY = 12;
const HISTORY_TTL = 60 * 60 * 24 * 7;

function clean(value, max = 256) {
  return String(value || "").trim().slice(0, max);
}

async function sha256(value) {
  const data = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function collectClientSignals(request) {
  const h = request.headers;
  const cf = request.cf || {};
  return {
    ua: clean(h.get("user-agent"), 384),
    deviceModel: clean(h.get("x-device-model"), 128),
    deviceOs: clean(h.get("x-device-os"), 64),
    osVersion: clean(h.get("x-os-version"), 64),
    hwid: clean(h.get("x-hwid"), 128),
    accept: clean(h.get("accept"), 128),
    acceptEncoding: clean(h.get("accept-encoding"), 128),
    httpVersion: clean(cf.httpProtocol || "", 32),
    country: clean(cf.country || h.get("cf-ipcountry") || "", 16),
    asn: String(cf.asn || ""),
    colo: clean(cf.colo || "", 32),
    ip: clean(h.get("cf-connecting-ip") || h.get("x-real-ip"), 64),
  };
}

export function scoreClientSignals(signals) {
  const ua = signals.ua.toLowerCase();
  const hasVpnUa = VPN_MARKERS.some((m) => ua.includes(m));
  let score = hasVpnUa ? 10 : 0;
  const reasons = [];

  if (hasVpnUa) reasons.push("vpn-ua");
  if (signals.hwid) score += 8; else reasons.push("missing-hwid");
  if (signals.deviceModel) score += 6; else if (/android|ios/i.test(ua)) reasons.push("missing-device-model");
  if (signals.deviceOs) score += 5;
  if (signals.osVersion) score += 3;
  if (/\*/.test(signals.accept)) score -= 3;
  if (/gzip|br/i.test(signals.acceptEncoding)) score += 3;

  // A normal Android Happ-like request usually carries the device headers.
  // Missing them is only a weak signal; it never blocks by itself.
  if (/happ\//i.test(signals.ua) && !signals.hwid) score -= 5;

  return { score: Math.max(0, Math.min(100, score)), hasVpnUa, reasons };
}

export async function buildClientFingerprint(signals) {
  // IP is included only in the hash so raw addresses never enter KV history.
  const material = [
    signals.ua.toLowerCase(), signals.deviceModel.toLowerCase(),
    signals.deviceOs.toLowerCase(), signals.osVersion.toLowerCase(),
    signals.hwid, signals.accept.toLowerCase(), signals.acceptEncoding.toLowerCase(),
    signals.httpVersion, signals.country, signals.asn, signals.colo, signals.ip
  ].join("\n");
  return sha256(material);
}

export async function inspectClientHistory(kv, identity, fingerprint, signals, baseRisk) {
  if (!kv) return { risk: baseRisk, repeated: false, changed: false, history: [] };

  const identityHash = await sha256(identity);
  const key = `sub_fp_${identityHash}`;
  let state = null;
  try { state = await kv.get(key, "json"); } catch { state = null; }

  const history = Array.isArray(state?.history) ? state.history.slice(0, MAX_HISTORY) : [];
  const previous = history[0];
  const repeated = !!previous && previous.fingerprint === fingerprint;
  const changed = !!previous && previous.fingerprint !== fingerprint;

  let risk = baseRisk;
  if (repeated) risk += 1;
  if (changed) risk += 12;

  const next = {
    fingerprint,
    hwid: signals.hwid ? await sha256(signals.hwid) : "",
    ua: signals.ua.slice(0, 160),
    at: Date.now()
  };
  const nextHistory = [next, ...history.filter((x) => x.fingerprint !== fingerprint)].slice(0, MAX_HISTORY);

  try {
    await kv.put(key, JSON.stringify({ history: nextHistory }), { expirationTtl: HISTORY_TTL });
  } catch (e) {
    console.warn("[Fingerprint] KV write failed:", e?.message || e);
  }

  return { risk: Math.max(0, Math.min(100, risk)), repeated, changed, history: nextHistory };
}

export function classifyClient(risk, signals, history) {
  const ua = signals.ua.toLowerCase();
  const isKnown = VPN_MARKERS.some((m) => ua.includes(m));
  const now = Date.now();
  const recent = (history || []).filter((x) => now - Number(x.at || 0) <= 10 * 60 * 1000);
  const recentDistinct = new Set(recent.map((x) => x.fingerprint)).size;

  // Strong decoder/scanner signal: a known VPN UA combined with several distinct
  // fingerprints in a short window. This is a heuristic, not proof of abuse.
  if (isKnown && (risk >= 60 || recentDistinct >= 4)) return "suspicious";
  if (isKnown) return "vpn";
  return "unknown";
}

const VPN_MARKERS = [
  "happ", "hiddify", "v2rayng", "v2raytun", "v2rayn", "v2box",
  "shadowrocket", "quantumult", "surge", "loon", "stash", "clash",
  "sing-box", "singbox", "karing", "nekoray", "nekobox", "streisand",
  "foxray", "matsuri", "flclash"
];
