const prefix = "vpn:";

export async function getUser(kv, chatId) {
  if (!kv || !chatId) return null;
  return kv.get(`${prefix}user:${chatId}`, "json");
}

export async function setUser(kv, chatId, value) {
  if (!kv || !chatId) throw new Error("BOT_STATE KV binding is required");
  await kv.put(`${prefix}user:${chatId}`, JSON.stringify(value));
  return value;
}

export async function deleteUser(kv, chatId) {
  if (!kv || !chatId) return;
  await kv.delete(`${prefix}user:${chatId}`);
}

export async function getSession(kv, chatId) {
  if (!kv || !chatId) return null;
  return kv.get(`${prefix}session:${chatId}`, "json");
}

export async function setSession(kv, chatId, value) {
  if (!kv || !chatId) throw new Error("BOT_STATE KV binding is required");
  await kv.put(`${prefix}session:${chatId}`, JSON.stringify(value));
  return value;
}

export async function clearSession(kv, chatId) {
  if (!kv || !chatId) return;
  await kv.delete(`${prefix}session:${chatId}`);
}
