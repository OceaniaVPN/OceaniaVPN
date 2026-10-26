import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile, getFileContent } from "./github.js";
import { sendMessage, answerCallback } from "./telegram.js";
import { COUNTRIES, detectCountryFromText } from "./contries.js";
import { listSubscriptions, getActiveSubscription, makeSubscriptionDeviceKey } from "./subscriptions.js";
import { buildHappJsonSubscription } from "./json-subscription.js";
import { getProxyPreference, getDecodedProfileProxyPreference } from "./proxy-preferences.js";
import { isKnownHttpProxyEndpoint } from "./proxy-check.js";
import { migrateLegacyKvToD1 } from "./migrate.js";
import { processScheduledChanges } from "./scheduler.js";

// ==========================================
// ОСНОВНАЯ КОНФИГУРАЦИЯ (4 источника)
// ==========================================
const AUTO_UPDATE_CONFIG = {
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 1,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: false,
  sources: [
    "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/Vless-Reality-White-Lists-Rus-Mobile.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-CIDR-RU-all.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads",
    "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-SNI-RU-all.txt",
    "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/WHITE-SNI-RU-all.txt"
  ]
};

// ==========================================
// ВТОРАЯ КОНФИГУРАЦИЯ (Только одна ссылка)
// ==========================================
const SECONDARY_CONFIG = {
  targetUrl: "https://okeaniavpn.dimastekolnikov1.workers.dev/sub", // Имя файла для этой подписки
  title: "OkeaniaVPN Auto",
  interval: 1,
  webpage: "https://t.me/free_vpn123456",
  announce: "OkeaniaVPN Auto Update",
  userinfo: "upload=0; download=0; total=536870912000; expire=0",
  doRename: false
};
function getSecondaryTargetUrl(env) {
  const url = new URL(SECONDARY_CONFIG.targetUrl);
  const token = String(env.SECONDARY_CONFIG_TOKEN || "").trim();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}


// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function fetchAndMergeSources(sourcesUrls, requestOptions = {}) {
  const allLines = [];
  const stats = {};
  for (const url of sourcesUrls) {
    try {
      console.log("[Merge] Fetching source body: " + url);
      const result = await decodeSubscription(url, false, false, requestOptions);
      const body = typeof result.rawContent === "string" ? result.rawContent : (result.content || "");
      if (result.ok && body.trim()) {
        const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
        allLines.push(...lines);
        stats[url] = lines.length;
        console.log("[Merge] Success: preserved " + lines.length + " body lines");
      } else {
        stats[url] = 0;
        console.log("[Merge] Failed or empty: " + result.error);
      }
    } catch (e) {
      console.error("[Merge] Error on " + url + ": " + e.message);
      stats[url] = 0;
    }
  }
  // Keep original entries; deduplicate only byte-identical lines from overlapping feeds.
  const uniqueLines = [...new Set(allLines)];
  console.log("[Merge] Body lines: " + allLines.length + ", exact-line dedup: " + uniqueLines.length);
  return { uris: uniqueLines, stats };
}

function getSuperscript(n) {
  const sup = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'];
  if (n <= 20) {
    return sup[n];
  }
  return "#" + n;
}

function applyRename(uris) {
  const counters = {};
  COUNTRIES.forEach(function(c) { counters[c.name] = 0; });
  counters["Рандом"] = 0;

  return uris.map(function(uri) {
    const hashIndex = uri.lastIndexOf('#');
    const baseUri = hashIndex === -1 ? uri : uri.substring(0, hashIndex);
    const originalName = hashIndex === -1 ? "" : decodeURIComponent(uri.substring(hashIndex + 1));

    let country = detectCountryFromText(originalName);
    if (!country) {
      const hostMatch = baseUri.match(/@([^:/]+)/);
      if (hostMatch) country = detectCountryFromText(hostMatch[1]);
    }

    const displayName = country ? country.name : "Рандом";
    const flag = country ? country.flag : "🌍";
    const counterKey = country ? country.name : "Рандом";

    counters[counterKey]++;
    const superscript = getSuperscript(counters[counterKey]);
    return baseUri + "#" + encodeURIComponent(flag + " " + displayName + " | БС" + superscript);
  });
}

// ==========================================
// 📦 РАЗДАЧА ПОДПИСКИ ПОД СВОИМ ДОМЕНОМ (/sub)
// Отдаёт содержимое файла подписки как есть (для импорта в VPN-клиент), но
// через домен воркера — так пользователь не видит прямую ссылку на GitHub
// (структуру репозитория, имена файлов) в самом клиенте.
//   ?u=<chatId>   → user_<chatId>.txt (личная подписка пользователя)
//   ?f=<filename> → произвольный файл в папке конфигов (например decoded_*.txt)
// ==========================================
// 📱 Список подстрок User-Agent известных VPN-клиентов, которым нужно отдавать
// НАСТОЯЩИЕ конфиги. Всё остальное (браузер, curl, превью-боты и т.д.) получает
// красивую тематическую HTML-страницу вместо конфигов — конфиги физически не
// покидают ответ сервера для не-VPN-клиентов, они просто не запрашивают их.
const VPN_CLIENT_UA_MARKERS = [
  "happ", "hiddify", "v2rayng", "v2raytun", "v2rayn", "v2box",
  "shadowrocket", "quantumult", "surge", "loon", "stash",
  "clash", "sing-box", "singbox", "karing", "nekoray", "nekobox",
  "streisand", "foxray", "matsuri", "flclash",
];

function isVpnClientUA(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return VPN_CLIENT_UA_MARKERS.some((m) => lower.includes(m));
}

function base64HeaderText(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `base64:${btoa(binary)}`;
}

function hasValidSubscriptionApiToken(request, configuredSecret) {
  if (!configuredSecret) return false;
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  if (supplied.length !== configuredSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < configuredSecret.length; i++) {
    diff |= supplied.charCodeAt(i) ^ configuredSecret.charCodeAt(i);
  }
  return diff === 0;
}

function stripLeadingSubscriptionHeaders(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let first = 0;
  while (first < lines.length) {
    const line = lines[first].trim();
    if (!line || line.startsWith("#")) first++;
    else break;
  }
  return lines.slice(first).join(newline);
}

async function serveSubscription(request, cfg) {
  const url = new URL(request.url);

  // Compact client diagnostics. Cloudflare's connecting IP is the peer seen at
  // the edge; when a VPN/proxy is active this is usually the proxy exit IP,
  // not the device's original/public IP. Never log subscription tokens or HWIDs.
  const userAgent = request.headers.get("user-agent") || "";
  const appMatch = userAgent.match(/(Happ|Hiddify|v2rayNG|v2rayTun|v2rayN|V2Box)[\/ ]([^\/ ]+)/i);
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
  console.log("[ClientLog] " + JSON.stringify({
    method: request.method,
    path: url.pathname,
    userAgent,
    client: appMatch ? appMatch[1] : (userAgent.split("/")[0] || "unknown"),
    appVersion: request.headers.get("x-app-version") || (appMatch ? appMatch[2] : "unknown"),
    deviceLocale: request.headers.get("x-device-locale") || "unknown",
    os: request.headers.get("x-device-os") || (userAgent.split("/")[2] || "unknown"),
    osVersion: request.headers.get("x-ver-os") || "unknown",
    device: request.headers.get("x-device-model") || "unknown",
    country: request.headers.get("cf-ipcountry") || request.cf?.country || "unknown",
    colo: request.cf?.colo || "unknown",
    asn: request.cf?.asn ?? null,
    asOrganization: request.cf?.asOrganization || "unknown",
    city: request.cf?.city || "unknown",
    region: request.cf?.region || "unknown",
    timezone: request.cf?.timezone || "unknown",
    tlsVersion: request.cf?.tlsVersion || "unknown",
    ip: clientIp,
    ipMeaning: "Cloudflare peer IP; may be VPN/proxy exit IP"
  }));

  const chatIdParam = url.searchParams.get("u");
  const subscriptionId = url.searchParams.get("s");
  const filenameParam = url.searchParams.get("f");

  let filename = filenameParam;
  let selected = null;
  let isOwnedDecodedProfile = false;
  if (chatIdParam) {
    if (filenameParam) {
      // A decoded profile may be served with ?u=<owner>&f=decoded_<owner>_...&p=platform.
      // Only filenames generated for this exact chat ID are accepted here.
      const ownedDecodedName = /^decoded_-?\d{1,20}_[a-z0-9]+\.txt$/i.test(filenameParam) &&
        filenameParam.startsWith(`decoded_${String(chatIdParam)}_`);
      if (!ownedDecodedName || subscriptionId) return new Response("Subscription not found", { status: 404 });
      filename = filenameParam;
      isOwnedDecodedProfile = true;
    } else {
      const subscriptions = await listSubscriptions(cfg, chatIdParam);
      selected = subscriptionId
        ? subscriptions.find((item) => item.id === subscriptionId)
        : await getActiveSubscription(cfg, chatIdParam);
      if (!selected) return new Response("Subscription not found", { status: 404 });
      filename = selected.filename;
    }
  }

  if (!filename) return new Response("Missing ?u= or ?f= parameter", { status: 400 });

  const sourceContent = await getFileContent(cfg, filename);
  if (!sourceContent) return new Response("Subscription not found", { status: 404 });

  const hasServiceAuth = hasValidSubscriptionApiToken(request, cfg.subscriptionApiSecret);
  if (!isVpnClientUA(userAgent) && !hasServiceAuth) {
    return renderThemedPage(request, cfg, sourceContent);
  }
  // Metadata is sent via response headers; the body receives only the payload.
  const content = stripLeadingSubscriptionHeaders(sourceContent);

  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const userinfoMatch = sourceContent.match(/^#subscription-userinfo:\s*(.+)$/im);
  if (userinfoMatch) headers["Subscription-Userinfo"] = userinfoMatch[1].trim();
  const titleMatch = sourceContent.match(/^#profile-title:\s*(.+)$/im);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    headers["Profile-Title"] = /[^\x20-\x7e]/.test(title) ? base64HeaderText(title) : title;
  }
  const intervalMatch = sourceContent.match(/^#profile-update-interval:\s*(.+)$/im);
  if (intervalMatch) headers["Profile-Update-Interval"] = intervalMatch[1].trim();
  const webpageMatch = sourceContent.match(/^#profile-web-page-url:\s*(.+)$/im);
  if (webpageMatch) headers["Profile-Web-Page-Url"] = webpageMatch[1].trim();

  // Track HWIDs only on user-owned subscription URLs (?u=...).
  // The same HWID remains one device when its IP changes.
  const deviceLimit = selected ? Math.max(0, Number.parseInt(selected.deviceLimit, 10) || 0) : 0;
  if (selected) {
    const hwid = (request.headers.get("x-hwid") || "").trim();
    const validHwid = /^[a-zA-Z0-9=-]{10,64}$/.test(hwid);
    if (deviceLimit > 0) {
      headers["X-Hwid-Active"] = "true";
      headers["subscription-always-hwid-enable"] = "1";
      headers["X-Hwid-Device-Limit"] = String(deviceLimit);
      if (!validHwid) {
        headers["X-Hwid-Not-Supported"] = "true";
        headers["Content-Type"] = "text/plain;charset=utf-8";
        headers["Announce"] = base64HeaderText("Устройство не передало корректный HWID. Включите HWID в настройках Happ.");
        return new Response("Device ID is required for this subscription. Enable HWID in Happ settings.", { status: 403, headers });
      }
    }

    // Track HWIDs even when the owner chooses an unlimited count. Tracking must not
    // become a reason to deny access when limits are disabled.
    if (validHwid && cfg.db && typeof cfg.db.registerSubscriptionDevice === "function") {
      try {
        const registration = await cfg.db.registerSubscriptionDevice({
          subscriptionKey: makeSubscriptionDeviceKey(chatIdParam, selected.id),
          hwid,
          deviceRef: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          deviceOs: request.headers.get("x-device-os") || "",
          deviceModel: request.headers.get("x-device-model") || "",
          userAgent,
          ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "",
          limit: deviceLimit,
        });
        if (deviceLimit > 0) headers["X-Hwid-Device-Count"] = String(registration.count);
        if (!registration.allowed && deviceLimit > 0) {
          headers["X-Hwid-Max-Devices-Reached"] = "true";
          headers["X-Hwid-Limit"] = "true";
          headers["Content-Type"] = "text/plain;charset=utf-8";
          headers["Announce"] = base64HeaderText(`Достигнут лимит устройств: ${registration.count}/${deviceLimit}. Удалите старое устройство в меню подписки.`);
          return new Response(`Device limit reached (${registration.count}/${deviceLimit}). Remove a device in the subscription settings.`, { status: 403, headers });
        }
      } catch (error) {
        console.error("[Subscription] HWID registration failed:", error?.message || error);
        if (deviceLimit > 0) {
          headers["Content-Type"] = "text/plain;charset=utf-8";
          headers["Announce"] = base64HeaderText("Не удалось проверить устройства. Попробуйте позже.");
          return new Response("Device-limit check failed", { status: 503, headers });
        }
      }
    } else if (deviceLimit > 0) {
      headers["Content-Type"] = "text/plain;charset=utf-8";
      headers["Announce"] = base64HeaderText("Временная ошибка проверки устройств. Попробуйте позже.");
      return new Response("Device-limit storage is unavailable", { status: 503, headers });
    }
  }

  const requestedPlatform = url.searchParams.get("p");
  const validPlatform = requestedPlatform === "android" || requestedPlatform === "windows";
  const isDecodeWizardProfile = isOwnedDecodedProfile && url.searchParams.get("scope") === "decode";
  // Only URLs created by the current /decode wizard use a per-file preference.
  // An explicit off choice must never inherit an older/global proxy selection.
  // The separate legacy proxy menu continues to use its platform preference.
  const proxyPreference = chatIdParam && validPlatform
    ? (isDecodeWizardProfile
        ? (await getDecodedProfileProxyPreference(cfg, chatIdParam, filenameParam, requestedPlatform) || { mode: "off", endpoint: null, country: null })
        : await getProxyPreference(cfg, chatIdParam, requestedPlatform))
    : null;
  let httpProxyEndpoint = null;
  if (proxyPreference?.mode === "on") {
    if (!isKnownHttpProxyEndpoint(proxyPreference.endpoint)) {
      return new Response("Saved proxy selection is invalid. Select a proxy again in the bot.", {
        status: 503,
        headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    httpProxyEndpoint = proxyPreference.endpoint;
  }

  // An explicit platform profile with a selected proxy is returned as Happ JSON
  // so Xray can chain the VPN-node connection through the chosen HTTP proxy.
  // Other profiles preserve their saved format.
  // Decoded profiles are immutable source payloads. A selected fetch proxy must
  // not trigger URI→JSON conversion or silently drop protocols (e.g. Hysteria).
  const format = isOwnedDecodedProfile
    ? "links"
    : (httpProxyEndpoint ? "json" : (selected?.format === "json" ? "json" : "links"));
  if (format === "json") {
    const result = buildHappJsonSubscription(content, httpProxyEndpoint);
    headers["Content-Type"] = "application/json;charset=utf-8";
    headers["Content-Disposition"] = 'inline; filename="subscription.json"';
    if (httpProxyEndpoint) headers["X-Oceania-Proxy-Mode"] = "HTTP-CONNECT";
    if (result.unsupported.length) headers["X-Subscription-Unsupported-Configs"] = String(result.unsupported.length);
    if (result.errors.length) headers["X-Subscription-Invalid-Configs"] = String(result.errors.length);
    if (result.unsupported.length || result.errors.length) {
      const skipped = result.unsupported.length + result.errors.length;
      headers["Announce"] = base64HeaderText(`${headers["Profile-Title"] || "Подписка"}: ${skipped} конфигураций не удалось представить в Happ JSON и они пропущены.${httpProxyEndpoint ? " HTTP-прокси работает только для TCP; UDP-зависимые узлы могут не работать." : ""}`);
    }
    if (!result.configs.length) {
      return new Response(JSON.stringify({ error: "No supported servers for Happ JSON subscription", unsupported: result.unsupported.map((item) => item.protocol) }), {
        status: 422,
        headers,
      });
    }
    return new Response(result.body, { headers });
  }

  headers["Content-Type"] = "text/plain;charset=utf-8";
  return new Response(content, { headers });
}

// ==========================================
// 🎨 ТЕМАТИЧЕСКАЯ СТРАНИЦА ПОДПИСКИ
// Показывается на ТОЙ ЖЕ ссылке /sub, что и конфиги — просто не-VPN клиенту
// (браузеру), см. serveSubscription выше. Берём случайную (или явно указанную
// через ?theme=) тему из папки temi/ в этом же репозитории и подставляем в неё
// РЕАЛЬНЫЙ статус подписки конкретного пользователя (вместо хардкода из
// шаблона), не трогая остальное оформление темы.
// ==========================================

const AVAILABLE_THEMES = ["beach", "forest", "gori", "ocean", "pustinya", "site"];

function pickTheme(explicit) {
  if (explicit && AVAILABLE_THEMES.includes(explicit)) return explicit;
  return AVAILABLE_THEMES[Math.floor(Math.random() * AVAILABLE_THEMES.length)];
}

// Парсит #заголовки: значение из файла подписки (тот же формат, что и в build.js/buildFile)
function parseFileHeaders(content) {
  const meta = {};
  for (const line of content.split("\n")) {
    if (!line.startsWith("#")) continue;
    const m = line.match(/^#([a-z0-9-]+):\s*(.+)$/i);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

// Принимает УЖЕ полученный content файла подписки (чтобы не дёргать GitHub
// второй раз) и рендерит тематическую страницу с реальным статусом.
async function renderThemedPage(request, cfg, content) {
  const url = new URL(request.url);
  const meta = parseFileHeaders(content);
  const title = meta["profile-title"] || "My Subscription";
  // #x-expire-ts / #x-expire-days-total пишутся в build.js на шаге 5/5 (/create).
  // Если их нет — подписка либо без ограничения по времени, либо создана до
  // появления этого шага; в обоих случаях считаем её безлимитной.
  const expireTs = parseInt(meta["x-expire-ts"], 10) || 0;
  const totalDaysHeader = parseInt(meta["x-expire-days-total"], 10) || 0;

  let status, daysLeft, totalDaysForBar, expiryDateStr;
  if (expireTs > 0) {
    const msLeft = expireTs * 1000 - Date.now();
    const daysLeftReal = Math.max(0, Math.ceil(msLeft / 86400000));
    status = daysLeftReal <= 0 ? "expired" : daysLeftReal <= 3 ? "expiring" : "active";
    daysLeft = daysLeftReal;
    totalDaysForBar = totalDaysHeader > 0 ? totalDaysHeader : Math.max(daysLeftReal, 1);
    expiryDateStr = new Date(expireTs * 1000).toLocaleDateString("ru-RU");
  } else {
    // Безлимитная подписка — полная зелёная полоса, без числа дней.
    status = "active";
    daysLeft = 1;
    totalDaysForBar = 1;
    expiryDateStr = "Без ограничений";
  }

  const themeName = pickTheme(url.searchParams.get("theme"));
  // cfg.configRepoOwner/configRepoName — это настраиваемый репозиторий
  // ХРАНЕНИЯ файлов подписок (user_*.txt), он может отличаться от репозитория
  // с кодом бота (env.CONFIG_REPO_NAME по умолчанию вообще "StekloVPN", см.
  // config.js). Папка temi/ живёт конкретно в OceaniaVPN/OceaniaVPN — зашиваем
  // это отдельно, не завязываясь на настраиваемый storage-репозиторий.
  const THEME_REPO_OWNER = "OceaniaVPN";
  const THEME_REPO_NAME = "OceaniaVPN";
  const THEME_BRANCH = "main";
  const themeUrl = `https://raw.githubusercontent.com/${THEME_REPO_OWNER}/${THEME_REPO_NAME}/${THEME_BRANCH}/temi/${themeName}.html`;

  let html;
  try {
    const themeRes = await fetch(themeUrl);
    if (!themeRes.ok) throw new Error("theme fetch status " + themeRes.status + " (" + themeUrl + ")");
    html = await themeRes.text();
  } catch (e) {
    return new Response("Theme page unavailable: " + e.message, { status: 502 });
  }

  // Подставляем РЕАЛЬНЫЕ данные в var DATA = {...} шаблона, не трогая остальные
  // декоративные поля темы (emoji/desc/instructions/gradient/botLink — они
  // авторские для каждой темы, их не меняем).
  const subJson = JSON.stringify({
    status,
    plan: title,
    expiryDate: expiryDateStr,
    daysLeft,
    totalDays: totalDaysForBar
  });
  html = html.replace(/subscription:\s*\{[^}]*\}/, `subscription: ${subJson}`);
  html = html.replace(/title:\s*'[^']*'/, `title: ${JSON.stringify(title)}`);

  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
}

async function pageSubscription(request, cfg) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get("u");
  const subscriptionId = url.searchParams.get("s");
  if (!chatId) return new Response("Missing ?u= parameter", { status: 400 });

  const subscriptions = await listSubscriptions(cfg, chatId);
  const selected = subscriptionId
    ? subscriptions.find((item) => item.id === subscriptionId)
    : await getActiveSubscription(cfg, chatId);
  if (!selected) return new Response("Subscription not found", { status: 404 });

  const content = await getFileContent(cfg, selected.filename);
  if (!content) return new Response("Subscription not found", { status: 404 });
  return renderThemedPage(request, cfg, content);
}

// Ручной запуск автообновления по команде /update.
// Работает в фоне через ctx.waitUntil(), чтобы Telegram webhook не ждал долгий декодер.
async function runManualUpdate(env, reportChatId) {
  const cfg = getConfig(env);
  const sendReport = async (text) => {
    if (reportChatId) await sendMessage(cfg.telegramToken, reportChatId, text);
  };

  try {
    const { uris: bodyLines } = await fetchAndMergeSources(AUTO_UPDATE_CONFIG.sources, {
      apiToken: env.SUBSCRIPTION_API_SECRET || "",
      apiOrigin: env.WORKER_ORIGIN || "",
      upstreamSecret: env.SUBSCRIPTION_UPSTREAM_SECRET || "",
      upstreamOrigin: env.SUBSCRIPTION_UPSTREAM_ORIGIN || "",
    });
    const content = bodyLines.join("\n");
    if (content.trim()) {
      const lineCount = bodyLines.length;
      const res = await createOrUpdateFile(cfg, AUTO_UPDATE_CONFIG.targetFilename, content, "Manual update: " + lineCount + " body lines");
      if (res.content || res.sha) {
        await sendReport("✅ <b>Основной конфиг обновлен!</b>\n\n📄 Строк передано без пересборки: <code>" + lineCount + "</code>");
      } else {
        await sendReport("⚠️ <b>Основной конфиг:</b> источники получены, но файл не подтверждён как обновлённый.");
      }
    } else {
      await sendReport("⚠️ <b>Основной конфиг:</b> источники вернули пустое тело; старый файл оставлен без изменений.");
    }
  } catch (e) {
    console.error("[Manual Update] Main error:", e);
    await sendReport("❌ <b>Основной конфиг — ошибка:</b> <code>" + String(e.message || e).replace(/[&<>]/g, "") + "</code>");
  }

  try {
    const result2 = await decodeSubscription(getSecondaryTargetUrl(env), true, false, {
      upstreamSecret: env.SUBSCRIPTION_UPSTREAM_SECRET || "",
      upstreamOrigin: env.SUBSCRIPTION_UPSTREAM_ORIGIN || new URL(SECONDARY_CONFIG.targetUrl).origin,
    });
    const content2 = typeof result2.rawContent === "string" ? result2.rawContent : "";
    if (result2.ok && content2.trim()) {
      const lineCount2 = content2.split(/\r?\n/).filter((line) => line.trim()).length;
      const res2 = await createOrUpdateFile(cfg, SECONDARY_CONFIG.targetFilename, content2, "Manual secondary update: " + lineCount2 + " body lines");
      if (res2.content || res2.sha) {
        await sendReport("✅ <b>Okeania конфиг обновлен!</b>\n\n📄 Строк передано без пересборки: <code>" + lineCount2 + "</code>");
      } else {
        await sendReport("⚠️ <b>Okeania:</b> файл не подтверждён как обновлённый.");
      }
    } else {
      await sendReport("❌ <b>Okeania:</b> пустой или недоступный источник." + (result2.error ? "\n<code>" + String(result2.error).replace(/[&<>]/g, "") + "</code>" : ""));
    }
  } catch (e) {
    console.error("[Manual Update] Okeania error:", e);
    await sendReport("❌ <b>Okeania — ошибка:</b> <code>" + String(e.message || e).replace(/[&<>]/g, "") + "</code>");
  }

  await sendReport("🏁 <b>Ручное обновление завершено.</b>");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check must not depend on D1/KV bindings or Telegram/GitHub secrets.
    // This lets us distinguish a live Worker from failures in application setup.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OceaniaVPN Bot OK", {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    let cfg;
    try {
      cfg = getConfig(env);
      if (!cfg.workerOrigin) cfg.workerOrigin = url.origin;
    } catch (e) {
      console.error("[Startup] Configuration initialization failed:", e?.stack || e);
      return new Response("Worker configuration error", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    if (request.method === "GET") {
      if (url.pathname === "/") return new Response("OceaniaVPN Bot OK", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/page") return pageSubscription(request, cfg);
      if (url.pathname === "/sub") return serveSubscription(request, cfg);
      if (url.pathname === "/set-webhook") {
        // Никогда не брать webhook URL из Host запроса:
        // старый домен/старый Worker мог перекинуть Telegram обратно на старую версию.
        // Приоритет: явный TELEGRAM_WEBHOOK_URL -> WORKER_ORIGIN -> текущий host.
        const workerUrl = (
          env.TELEGRAM_WEBHOOK_URL ||
          env.WORKER_ORIGIN ||
          url.origin
        ).replace(/\/$/, "");

        const apiUrl = "https://api.telegram.org/bot" + cfg.telegramToken +
          "/setWebhook?url=" + encodeURIComponent(workerUrl);

        const res = await fetch(apiUrl, { method: "POST" });
        const body = await res.text();

        console.log("[Webhook] setWebhook ->", workerUrl, body);
        return new Response(JSON.stringify({
          ok: res.ok,
          webhookUrl: workerUrl,
          telegram: (() => {
            try { return JSON.parse(body); } catch { return body; }
          })()
        }), {
          status: res.ok ? 200 : 502,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/webhook-info") {
        const res = await fetch(
          "https://api.telegram.org/bot" + cfg.telegramToken + "/getWebhookInfo",
          { method: "POST" }
        );
        return new Response(await res.text(), {
          status: res.ok ? 200 : 502,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "POST") {
      let update = null;
      try {
        update = await request.json();
        const messageText = update.message?.text?.trim();
        if (update.message && messageText === "/update") {
          const chatId = update.message.chat.id;
          if (!cfg.adminId || update.message.from?.id !== cfg.adminId) {
            await sendMessage(cfg.telegramToken, chatId, "⛔️ Нет прав для этой команды.");
          } else {
            await sendMessage(cfg.telegramToken, chatId, "⏳ <b>/update запущен.</b>\n\nОбновление выполняется в фоне. Результат придёт сюда после каждого конфига.");
            ctx.waitUntil(runManualUpdate(env, chatId));
          }
          return new Response("OK", { status: 200 });
        }
        if (update.callback_query) {
          const cb = update.callback_query;

          // Callback webhook must return HTTP 200 immediately. Telegram only
          // needs acknowledgement here; all API/KV work is best-effort.
          ctx.waitUntil((async () => {
            try {
              try {
                await answerCallback(cfg.telegramToken, cb.id);
              } catch (callbackAnswerError) {
                console.error("[Webhook] answerCallbackQuery failed:", callbackAnswerError);
              }

              // Callback handling must not depend on legacy KV availability.
              // Telegram buttons remain functional during and after the D1 migration.
              const duplicate = false;

              if (!duplicate) {
                await handleCallback(cfg, cb, { callbackAlreadyAnswered: true });
              }
            } catch (callbackError) {
              console.error("[Webhook] Callback handler error:", callbackError);

              const chatId = cb.message?.chat?.id;
              if (chatId) {
                try {
                  await sendMessage(
                    cfg.telegramToken,
                    chatId,
                    `❌ <b>Не удалось выполнить кнопку.</b>\\n\\n<code>${String(callbackError?.message || callbackError).replace(/[&<>]/g, "")}</code>`,
                  );
                } catch (reportError) {
                  console.error("[Webhook] Failed to report callback error:", reportError);
                }
              }
            }
          })());

          return new Response("OK", { status: 200 });
        } else if (update.message) await handleMessage(cfg, update.message);
        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error("[Webhook] Request handler error:", e);
        const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
        if (chatId) {
          try {
            await sendMessage(
              cfg.telegramToken,
              chatId,
              `⚠️ <b>Операция не выполнена.</b>\n\n<code>${String(e?.message || e).replace(/[&<>]/g, "")}</code>`
            );
          } catch (reportError) {
            console.error("[Webhook] Failed to report request error:", reportError);
          }
        }
        return new Response("OK", { status: 200 });
      }
    }
    return new Response("Method not allowed", { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log("[Cron] Auto-update triggered at:", new Date().toISOString());
    const cfg = getConfig(env);

    try {
      const scheduleResult = await processScheduledChanges(cfg);
      console.log("[Cron] Scheduled changes:", scheduleResult);
    } catch (e) {
      console.error("[Cron] Scheduled changes error:", e);
    }

    // Черновики проверяются каждую минуту, а тяжёлое обновление источников — только раз в 4 часа.
    if (event.cron !== "0 * * * *") return;

    // 1. Обновление основного whitelist.txt (4 источника)
    try {
      const { uris: bodyLines, stats } = await fetchAndMergeSources(AUTO_UPDATE_CONFIG.sources, {
        apiToken: env.SUBSCRIPTION_API_SECRET || "",
        apiOrigin: env.WORKER_ORIGIN || "",
        upstreamSecret: env.SUBSCRIPTION_UPSTREAM_SECRET || "",
        upstreamOrigin: env.SUBSCRIPTION_UPSTREAM_ORIGIN || "",
      });
      const content = bodyLines.join("\n");
      if (content.trim()) {
        const lineCount = bodyLines.length;
        const res = await createOrUpdateFile(cfg, AUTO_UPDATE_CONFIG.targetFilename, content, "Auto update: " + lineCount + " body lines");
        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + AUTO_UPDATE_CONFIG.targetFilename;
          await sendMessage(cfg.telegramToken, cfg.adminId, "✅ <b>Основной конфиг обновлен!</b>\n\n📄 Строк передано без пересборки: <code>" + lineCount + "</code>\n🔗 <a href=\"" + rawUrl + "\">Открыть</a>");
        }
        console.log("[Cron] Main update success: " + lineCount + " body lines; sources: " + JSON.stringify(stats));
      } else {
        console.error("[Cron] Main update skipped: all source bodies were empty or unavailable.");
      }
    } catch (e) {
      console.error("[Cron] Main Update Error:", e);
    }

    // 2. Обновление второго конфига (okeania_auto.txt)
    try {
      console.log("[Cron] Decoding secondary source: " + SECONDARY_CONFIG.targetUrl);
      // Service-to-service auth is sent only to the configured upstream origin.
      // The upstream must validate X-Bot-Secret; do not rely on a spoofed client UA.
      const result2 = await decodeSubscription(getSecondaryTargetUrl(env), true, false, {
        upstreamSecret: env.SUBSCRIPTION_UPSTREAM_SECRET || "",
        upstreamOrigin: env.SUBSCRIPTION_UPSTREAM_ORIGIN || new URL(SECONDARY_CONFIG.targetUrl).origin,
      });
      const content2 = typeof result2.rawContent === "string" ? result2.rawContent : "";
      if (result2.ok && content2.trim()) {
        const lineCount2 = content2.split(/\r?\n/).filter((line) => line.trim()).length;
        const res2 = await createOrUpdateFile(cfg, SECONDARY_CONFIG.targetFilename, content2, "Secondary Auto update: " + lineCount2 + " body lines");
        if ((res2.content || res2.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl2 = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + SECONDARY_CONFIG.targetFilename;
          await sendMessage(cfg.telegramToken, cfg.adminId, "✅ <b>Второй конфиг (Okeania) обновлен!</b>\n\n📄 Строк передано без пересборки: <code>" + lineCount2 + "</code>\n🔗 <a href=\"" + rawUrl2 + "\">Открыть</a>");
        }
        console.log("[Cron] Secondary success: " + lineCount2 + " body lines saved");
      } else {
        console.error("[Cron] Secondary Failed:", result2.error || "empty payload");
      }
    } catch (e) {
      console.error("[Cron] Secondary Update Error:", e);
    }
  }
};
