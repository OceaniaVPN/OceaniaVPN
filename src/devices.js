import deviceCatalog from "./devices.json" with { type: "json" };

const DEVICES = Array.isArray(deviceCatalog?.devices) ? deviceCatalog.devices : [];
const DEVICE_PREFIX = "subscription_device:";

const DEVICE_BY_ID = new Map(
  DEVICES.map((device) => [String(device.id).toLowerCase(), device])
);

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function detectDeviceFromRequest(request) {
  // Happ передаёт модель и ОС отдельными заголовками.
  // Пример: x-device-model: 2311DRK48G, x-device-os: Android
  const modelHeader = request.headers.get("x-device-model") || "";
  const osHeader = request.headers.get("x-device-os") || "";
  const userAgent = request.headers.get("user-agent") || "";
  const secModel = request.headers.get("sec-ch-ua-model") || "";

  const candidates = [modelHeader, secModel, userAgent]
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  let match = null;
  for (const value of candidates) {
    for (const [id, device] of DEVICE_BY_ID) {
      if (value.includes(id)) {
        match = device;
        break;
      }
    }
    if (match) break;
  }

  // Даже если модели ещё нет в devices.json, сохраняем данные клиента,
  // чтобы вкладка не оставалась пустой.
  const model = modelHeader || secModel || "";
  if (!match && !model) return null;

  return {
    device: match || {
      id: model || "unknown",
      name: model || "Неизвестное устройство",
      brand: "Неизвестно",
      os: osHeader || "Неизвестно",
      type: "Устройство",
      year: null,
    },
    model,
    os: osHeader,
    userAgent,
    hwid: request.headers.get("x-hwid") || "",
  };
}

export async function recordSubscriptionDevice(store, chatId, request, secret) {
  if (!store) return null;

  const detected = detectDeviceFromRequest(request);
  if (!detected) return null;

  // HWID используем только для дедупликации и не сохраняем в KV.
  // Если HWID нет, используем комбинацию модели и User-Agent.
  const identity = detected.hwid
    ? `hwid:${detected.hwid}`
    : `device:${detected.device.id}|model:${detected.model}|ua:${detected.userAgent}`;

  const fingerprint = await sha256Hex(`${secret || ""}|${chatId}|${identity}`);
  const key = `${DEVICE_PREFIX}${chatId}:${fingerprint}`;
  const now = new Date().toISOString();

  await store.put(key, "", {
    expirationTtl: 60 * 60 * 24 * 90,
    metadata: {
      id: detected.device.id,
      name: detected.device.name,
      brand: detected.device.brand,
      os: detected.device.os || detected.device.os,
      type: detected.device.type,
      year: detected.device.year || null,
      lastSeen: now,
    },
  });

  return { ...detected.device, lastSeen: now };
}

export async function listSubscriptionDevices(store, chatId) {
  if (!store) return [];

  const prefix = `${DEVICE_PREFIX}${chatId}:`;
  const devices = [];
  let cursor;

  do {
    const result = await store.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });

    for (const key of result.keys || []) {
      if (key.metadata) devices.push(key.metadata);
    }

    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  return devices.sort((a, b) =>
    String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""))
  );
}

export async function clearSubscriptionDevices(store, chatId) {
  if (!store) return;

  const prefix = `${DEVICE_PREFIX}${chatId}:`;
  let cursor;

  do {
    const result = await store.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const key of result.keys || []) {
      await store.delete(key.name);
    }
    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);
}
