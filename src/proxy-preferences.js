const VALID_PLATFORMS = new Set(["android", "windows"]);

function prefKey(chatId, platform) {
  return `proxy_pref_${String(chatId)}_${platform}`;
}
function activePlatformKey(chatId) {
  return `proxy_active_platform_${String(chatId)}`;
}

export async function getProxyPreference(cfg, chatId, platform) {
  if (!cfg?.store || !VALID_PLATFORMS.has(platform)) return null;
  try {
    const value = await cfg.store.get(prefKey(chatId, platform), "json");
    if (!value || typeof value !== "object") return null;
    if (value.mode !== "on" && value.mode !== "off") return null;
    return value;
  } catch (error) {
    console.error("[Proxy] preference read failed:", error?.message || error);
    return null;
  }
}

export async function getActiveProxyPreference(cfg, chatId) {
  if (!cfg?.store) return { platform: "android", preference: null };
  let platform = "android";
  try {
    const saved = await cfg.store.get(activePlatformKey(chatId));
    if (VALID_PLATFORMS.has(saved)) platform = saved;
  } catch {}
  return { platform, preference: await getProxyPreference(cfg, chatId, platform) };
}

export async function setProxyPreference(cfg, chatId, platform, preference) {
  if (!cfg?.store) throw new Error("Для сохранения выбора прокси нужна настроенная KV/D1 база");
  if (!VALID_PLATFORMS.has(platform)) throw new Error("Неизвестная платформа");
  if (!preference || !["on", "off"].includes(preference.mode)) throw new Error("Некорректный режим прокси");
  const normalized = {
    mode: preference.mode,
    endpoint: preference.mode === "on" ? String(preference.endpoint || "") : null,
    country: preference.mode === "on" ? String(preference.country || "") : null,
    updatedAt: Date.now(),
  };
  if (normalized.mode === "on" && !normalized.endpoint) throw new Error("Не выбран адрес прокси");
  await cfg.store.put(prefKey(chatId, platform), JSON.stringify(normalized));
  await cfg.store.put(activePlatformKey(chatId), platform);
  return normalized;
}


function lastDecodedProfileKey(chatId) {
  return `last_decoded_profile_${String(chatId)}`;
}

function isOwnedDecodedFilename(filename, chatId) {
  const value = String(filename || "");
  return /^decoded_-?\d{1,20}_[a-z0-9]+\.txt$/i.test(value) && value.startsWith(`decoded_${String(chatId)}_`);
}

export async function getLastDecodedProfile(cfg, chatId) {
  if (!cfg?.store) return null;
  try {
    const filename = await cfg.store.get(lastDecodedProfileKey(chatId));
    return isOwnedDecodedFilename(filename, chatId) ? filename : null;
  } catch (error) {
    console.error("[Proxy] last decoded profile read failed:", error?.message || error);
    return null;
  }
}

export async function setLastDecodedProfile(cfg, chatId, filename) {
  if (!cfg?.store) return false;
  if (!isOwnedDecodedFilename(filename, chatId)) throw new Error("Имя декодированного профиля не прошло проверку");
  await cfg.store.put(lastDecodedProfileKey(chatId), filename);
  return true;
}


function decodedProfileProxyKey(chatId, filename, platform) {
  return `decoded_proxy_${String(chatId)}_${platform}_${filename}`;
}

// Proxy choices made during /decode belong to that generated profile only.
// They must not fall back to the user's older/global platform preference.
export async function getDecodedProfileProxyPreference(cfg, chatId, filename, platform) {
  if (!cfg?.store || !VALID_PLATFORMS.has(platform) || !isOwnedDecodedFilename(filename, chatId)) return null;
  try {
    const value = await cfg.store.get(decodedProfileProxyKey(chatId, filename, platform), "json");
    if (!value || typeof value !== "object" || !["on", "off"].includes(value.mode)) return null;
    if (value.mode === "off") return { mode: "off", endpoint: null, country: null };
    if (!value.endpoint || typeof value.endpoint !== "string") return null;
    return { mode: "on", endpoint: value.endpoint, country: String(value.country || "") };
  } catch (error) {
    console.error("[Proxy] decoded profile preference read failed:", error?.message || error);
    return null;
  }
}

export async function setDecodedProfileProxyPreference(cfg, chatId, filename, platform, preference) {
  if (!cfg?.store) throw new Error("Для сохранения выбора прокси нужна настроенная KV/D1 база");
  if (!VALID_PLATFORMS.has(platform)) throw new Error("Неизвестная платформа");
  if (!isOwnedDecodedFilename(filename, chatId)) throw new Error("Файл декодированной подписки не принадлежит этому пользователю");
  if (!preference || !["on", "off"].includes(preference.mode)) throw new Error("Некорректный режим прокси");
  const normalized = preference.mode === "on"
    ? { mode: "on", endpoint: String(preference.endpoint || ""), country: String(preference.country || ""), updatedAt: Date.now() }
    : { mode: "off", endpoint: null, country: null, updatedAt: Date.now() };
  if (normalized.mode === "on" && !normalized.endpoint) throw new Error("Не выбран адрес прокси");
  // The file is an immutable generated decode result. Keep its choice long enough
  // for clients to refresh the profile, without making it a global user setting.
  await cfg.store.put(decodedProfileProxyKey(chatId, filename, platform), JSON.stringify(normalized), { expirationTtl: 60 * 24 * 3600 });
  return normalized;
}
