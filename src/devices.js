import deviceCatalog from "./devices.json" with { type: "json" };

const DEVICES = Array.isArray(deviceCatalog?.devices) ? deviceCatalog.devices : [];
const DEVICE_PREFIX = "subscription_device:";

const DEVICE_BY_ID = new Map(
  DEVICES.map((device) => [String(device.id).toLowerCase(), device])
);

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    ""
  );
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function detectDeviceFromRequest(request) {
  const userAgent = request.headers.get("user-agent") || "";
  const modelHeader = request.headers.get("sec-ch-ua-model") || "";
  const haystack = `${modelHeader} ${userAgent}`.toLowerCase();

  let match = null;
  for (const [id, device] of DEVICE_BY_ID) {
    if (haystack.includes(id)) {
      match = device;
      break;
    }
  }

  if (!match) return null;

  return {
    device: match,
    userAgent,
    modelHeader,
    ip: getClientIp(request),
  };
}

export async function recordSubscriptionDevice(kv, chatId, request, secret) {
  if (!kv) return null;

  const detected = detectDeviceFromRequest(request);
  if (!detected) return null;

  // Не сохраняем IP или User-Agent. Они используются только для создания
  // стабильного хеша, чтобы несколько запросов одного клиента не считались
  // разными устройствами.
  const fingerprint = await sha256Hex(
    `${secret || ""}|${detected.device.id}|${detected.userAgent}|${detected.modelHeader}|${detected.ip}`
  );

  const key = `${DEVICE_PREFIX}${chatId}:${fingerprint}`;
  const now = new Date().toISOString();

  await kv.put(key, "", {
    expirationTtl: 60 * 60 * 24 * 90,
    metadata: {
      id: detected.device.id,
      name: detected.device.name,
      brand: detected.device.brand,
      os: detected.device.os,
      type: detected.device.type,
      year: detected.device.year,
      lastSeen: now,
    },
  });

  return { ...detected.device, lastSeen: now };
}

export async function listSubscriptionDevices(kv, chatId) {
  if (!kv) return [];

  const prefix = `${DEVICE_PREFIX}${chatId}:`;
  const devices = [];
  let cursor;

  do {
    const result = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });

    for (const key of result.keys || []) {
      if (key.metadata) devices.push(key.metadata);
    }

    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  return devices.sort((a, b) =>
    String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""))
  );
}

export async function clearSubscriptionDevices(kv, chatId) {
  if (!kv) return;

  const prefix = `${DEVICE_PREFIX}${chatId}:`;
  let cursor;

  do {
    const result = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of result.keys || []) {
      await kv.delete(key.name);
    }
    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);
}
