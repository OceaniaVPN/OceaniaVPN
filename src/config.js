import { createD1Store } from "./d1.js";
export function getConfig(env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    adminId: parseInt(env.ADMIN_ID || "0"),
    configRepoOwner: env.CONFIG_REPO_OWNER || "OceaniaVPN",
    configRepoName: env.CONFIG_REPO_NAME || "StekloVPN",
    // Репо где лежит папка temi/ с HTML-темами. По умолчанию = репо бота (OceaniaVPN/OceaniaVPN).
    botRepoName: env.BOT_REPO_NAME || env.CONFIG_REPO_OWNER || "OceaniaVPN",
    configsFolder: env.CONFIGS_FOLDER || "configs",
    branch: env.BRANCH || "main",
    db: createD1Store(env.BOT_DB),
    // D1 is the primary state store. BOT_STATE remains available only during
    // the one-time KV -> D1 migration window.
    store: createD1Store(env.BOT_DB) || env.BOT_STATE,
    legacyKv: env.BOT_STATE || null,
    // 🎨 Нужен для сборки ссылки на тематическую страницу подписки (/page —
    // см. index.js). Задай в переменных Worker'а (Settings → Variables):
    // WORKER_ORIGIN = https://твой-воркер.workers.dev (без слэша в конце).
    workerOrigin: (env.WORKER_ORIGIN || "").replace(/\/$/, ""),
    subscriptionSecret: env.SUBSCRIPTION_SECRET || env.TELEGRAM_BOT_TOKEN || "",
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
  };
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function signSubscriptionPath(cfg, kind, value) {
  if (!cfg.subscriptionSecret) throw new Error("SUBSCRIPTION_SECRET is not configured");
  return hmacSha256(cfg.subscriptionSecret, `${kind}:${value}`);
}

export async function verifySubscriptionPath(cfg, kind, value, signature) {
  if (!cfg.subscriptionSecret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = await hmacSha256(cfg.subscriptionSecret, `${kind}:${value}`);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function isValidChatId(value) {
  return /^-?\d{1,20}$/.test(String(value || ""));
}

export function isSafeConfigFilename(value) {
  return /^(?:user_-?\d{1,20}(?:_[a-z0-9-]{1,64})?|decoded_-?\d{1,20}_[a-z0-9]+)\.txt$/i.test(String(value || ""));
}
