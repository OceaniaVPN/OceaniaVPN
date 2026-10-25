// Base profiles kept as fallback when a subscription endpoint rejects a request.
export const TARGET_USER_AGENTS = [
  "Happ/4.7.1/Android/88513504853466813075",
  "Happ/4.3.0 (Windows 11; x64)",
  "Happ/6.0.0 (iOS 19.2; iPhone 16)",
  "Happ/4.7.1 (Android 14; Motorola Edge 60)",
  "Happ/4.7.1 (Android 12; Honor Magic 7 Pro) okhttp/4.12.0",
  "Happ/4.7.1/Android/43614936463726875088",
  "Happ/4.7.1/Android/63082621507177129420",
  "Happ/4.3.0 (macOS 16.0; arm64)",
  "Happ/4.7.1 (Android 17; Redmi Note 15)",
  "Happ/4.3.0 (Linux; arm64)",
  "Happ/4.7.1 (Android 15; Samsung Galaxy Z Fold 7) okhttp/4.12.0",
  "Happ/4.7.1/Android/44979973576802226154",
  "Happ/6.0.0 (iOS 18.4; iPad Air (M3))",
  "Happ/6.0.0 (iOS 17.5; iPhone 16 Pro)",
  "Happ/4.7.1 (Android 16; Google Pixel 8 Pro) okhttp/4.12.0",
  "Happ/4.3.0 (Windows 11; arm64)",
  "Happ/4.7.1 (Android 15; Poco F6)",
  "Happ/6.0.0 (iOS 20.0; iPhone 18 Pro Max)",
  "Happ/4.7.1 (Android 15; realme 15 Pro) okhttp/4.12.0",
  "Happ/4.3.0 (macOS 15.0; x86_64)"
];

const DEFAULTS = {
  Android: { version: "4.8.0", deviceId: "17921395329952009531" },
  Windows: { version: "4.5.4", deviceId: "2610141139602" },
  iOS: { version: "6.0.0", deviceId: "" },
  macOS: { version: "4.3.0", deviceId: "" },
  Linux: { version: "4.3.0", deviceId: "" }
};

export function normalizeHappPlatform(value) {
  const raw = String(value || "Android").trim().toLowerCase();
  if (["windows", "win", "pc", "desktop"].includes(raw)) return "Windows";
  if (["ios", "iphone", "ipad"].includes(raw)) return "iOS";
  if (["macos", "mac", "osx"].includes(raw)) return "macOS";
  if (raw === "linux") return "Linux";
  return "Android";
}

function safeVersion(value, fallback) {
  const candidate = String(value || "").trim();
  return /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(candidate) ? candidate : fallback;
}

function safeDeviceId(value, fallback = "") {
  const candidate = String(value || "").trim();
  return /^\d{4,32}$/.test(candidate) ? candidate : fallback;
}

function profileUserAgent(platform, version, deviceId) {
  if (["Android", "Windows"].includes(platform) && deviceId) {
    return `Happ/${version}/${platform}/${deviceId}`;
  }
  if (platform === "iOS") return `Happ/${version} (iOS 18.4; iPhone)`;
  if (platform === "macOS") return `Happ/${version} (macOS 15.0; arm64)`;
  return `Happ/${version} (Linux; arm64)`;
}

/**
 * Build a deterministic attempt order. Android is tried first by default,
 * then Windows. Set HAPP_PLATFORM=Windows to reverse that order.
 * HAPP_VERSION normally overrides the version for both configurable profiles.
 * With happVersionScope="selected", it changes only the preferred profile;
 * the fallback profile retains its platform default version.
 */
export function getHappUserAgents(options = {}) {
  const preferred = normalizeHappPlatform(options.happPlatform ?? options.platform);
  const versionOverride = String(options.happVersion ?? options.version ?? "").trim();
  const selectedOnly = options.happVersionScope === "selected";
  const sharedId = options.happDeviceId ?? options.deviceId ?? "";
  const order = [preferred, preferred === "Android" ? "Windows" : "Android"];
  const configured = order.map((platform) => {
    const defaults = DEFAULTS[platform];
    const applyOverride = !selectedOnly || platform === preferred;
    const version = applyOverride ? safeVersion(versionOverride, defaults.version) : defaults.version;
    const id = safeDeviceId(sharedId, defaults.deviceId);
    return profileUserAgent(platform, version, id);
  });
  return [...new Set([...configured, ...TARGET_USER_AGENTS])];
}

export function getHappPlatformFromUserAgent(ua) {
  const text = String(ua || "");
  if (/windows/i.test(text) || /\/Windows\//i.test(text)) return "Windows";
  if (/ios|iphone|ipad/i.test(text)) return "iOS";
  if (/macos|mac os|osx/i.test(text)) return "macOS";
  if (/linux/i.test(text)) return "Linux";
  if (/android/i.test(text) || /\/Android\//i.test(text)) return "Android";
  return "Android";
}

export function getHappVersionFromUserAgent(ua) {
  const match = String(ua || "").match(/\bHapp\/([\d.]+)/i);
  return match?.[1] || "";
}

export function getHappDeviceIdFromUserAgent(ua) {
  const match = String(ua || "").match(/\/(?:Android|Windows)\/(\d{4,32})(?:\b|$)/i);
  return match?.[1] || "";
}
