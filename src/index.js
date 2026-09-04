import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile, getFileContent } from "./github.js";
import { sendMessage } from "./telegram.js";
import { COUNTRIES, detectCountryFromText } from "./contries.js";

// ==========================================
// ОСНОВНАЯ КОНФИГУРАЦИЯ (4 источника)
// ==========================================
const AUTO_UPDATE_CONFIG = {
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: true,
  sources: [
    "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/Vless-Reality-White-Lists-Rus-Mobile.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-CIDR-RU-all.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads",
    "https://raw.githubusercontent.com/LimeHi/LimeVPN/refs/heads/main/whitelist.txt"
    "http://78.17.106.76:2096/sub/i8lwnzmaz0cobdu6
  ]
};

// ==========================================
// ВТОРАЯ КОНФИГУРАЦИЯ (Только одна ссылка)
// ==========================================
const SECONDARY_CONFIG = {
  targetUrl: "https://okeaniavpn.dimastekolnikov1.workers.dev/sub?token=0fe191f6-7ec7-44ec-aed7-cc6423745ca8",
  targetFilename: "okeania_auto.txt", // Имя файла для этой подписки
  title: "OkeaniaVPN Auto",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "OkeaniaVPN Auto Update",
  userinfo: "upload=0; download=0; total=536870912000; expire=0",
  doRename: true
};

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

async function fetchAndMergeSources(sourcesUrls) {
  const allUris = [];
  const stats = {};
  for (const url of sourcesUrls) {
    try {
      console.log("[Merge] Decoding source: " + url);
      const result = await decodeSubscription(url);
      if (result.ok && result.uris && result.uris.length > 0) {
        allUris.push(...result.uris);
        stats[url] = result.uris.length;
        console.log("[Merge] Success: Found " + result.uris.length + " URIs");
      } else {
        stats[url] = 0;
        console.log("[Merge] Failed or empty: " + result.error);
      }
    } catch (e) {
      console.error("[Merge] Error on " + url + ": " + e.message);
      stats[url] = 0;
    }
  }
  const uniqueUris = [...new Set(allUris)];
  console.log("[Merge] Total URIs: " + allUris.length + ", After dedup: " + uniqueUris.length);
  return { uris: uniqueUris, stats };
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
async function serveSubscription(request, cfg) {
  const url = new URL(request.url);
  const chatIdParam = url.searchParams.get("u");
  const filenameParam = url.searchParams.get("f");
  const filename = chatIdParam ? `user_${chatIdParam}.txt` : filenameParam;
  if (!filename) return new Response("Missing ?u= or ?f= parameter", { status: 400 });

  const content = await getFileContent(cfg, filename);
  if (!content) return new Response("Subscription not found", { status: 404 });

  // 🔧 ФИКС РАССИНХРОНА ДНЕЙ: VPN-клиент (Happ/v2rayNG/Hiddify) читает срок
  // действия НЕ из текстового комментария #subscription-userinfo внутри тела
  // файла, а из настоящего HTTP-заголовка Subscription-Userinfo на самом
  // ответе. Раньше этот заголовок вообще не выставлялся — клиент либо не
  // показывал срок, либо показывал что-то своё, а /page считал дни отдельно
  // из тела файла. Теперь оба берут значение из ОДНОЙ и той же строки файла —
  // расхождения быть не может.
  const headers = {
    "Content-Type": "text/plain;charset=utf-8",
    "Cache-Control": "no-store",
  };
  const userinfoMatch = content.match(/^#subscription-userinfo:\s*(.+)$/im);
  if (userinfoMatch) headers["Subscription-Userinfo"] = userinfoMatch[1].trim();
  const titleMatch = content.match(/^#profile-title:\s*(.+)$/im);
  if (titleMatch) headers["Profile-Title"] = titleMatch[1].trim();
  const intervalMatch = content.match(/^#profile-update-interval:\s*(.+)$/im);
  if (intervalMatch) headers["Profile-Update-Interval"] = intervalMatch[1].trim();
  const webpageMatch = content.match(/^#profile-web-page-url:\s*(.+)$/im);
  if (webpageMatch) headers["Profile-Web-Page-Url"] = webpageMatch[1].trim();

  return new Response(content, { headers });
}

// ==========================================
// 🎨 ТЕМАТИЧЕСКАЯ СТРАНИЦА ПОДПИСКИ (/page)
// Открывается по ссылке из #profile-web-page-url в файле подписки — VPN-клиент
// показывает её как кликабельную ссылку в информации о профиле. Берём случайную
// (или явно указанную) тему из папки temi/ в этом же репозитории и подставляем
// в неё РЕАЛЬНЫЙ статус подписки конкретного пользователя (вместо хардкода из
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

async function pageSubscription(request, cfg) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get("u");
  if (!chatId) return new Response("Missing ?u= parameter", { status: 400 });

  const filename = `user_${chatId}.txt`;
  const content = await getFileContent(cfg, filename);
  if (!content) return new Response("Subscription not found", { status: 404 });

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
  // 🔧 ФИКС 404: cfg.configRepoOwner/configRepoName — это настраиваемый репозиторий
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

  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" }
  });
}

// ==========================================
// ОСНОВНОЙ ЭКСПОРТ WORKER
// ==========================================

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);

    // Auto-detect workerOrigin из входящего запроса — не нужна отдельная env-
    // переменная, ссылки на /page и /sub всегда указывают на тот домен,
    // с которого реально пришёл запрос (например
    // https://oceaniavpn.dimastekolnikov13.workers.dev).
    if (!cfg.workerOrigin) {
      cfg.workerOrigin = url.origin;
    }

    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response("OceaniaVPN Bot OK", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/page") {
        return pageSubscription(request, cfg);
      }
      if (url.pathname === "/sub") {
        return serveSubscription(request, cfg);
      }
      if (url.pathname === "/set-webhook") {
        const workerUrl = url.protocol + "//" + url.host;
        const res = await fetch("https://api.telegram.org/bot" + cfg.telegramToken + "/setWebhook?url=" + workerUrl, { method: "POST" });
        return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "POST") {
      try {
        const update = await request.json();
        if (update.callback_query) await handleCallback(cfg, update.callback_query);
        else if (update.message) await handleMessage(cfg, update.message);
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
      }
    }
    return new Response("Method not allowed", { status: 405 });
  },

  async scheduled(event, env, ctx) {
    console.log("[Cron] Auto-update triggered at:", new Date().toISOString());
    const cfg = getConfig(env);

    // 1. Обновление основного whitelist.txt (4 источника)
    try {
      const { uris: uniqueUris, stats } = await fetchAndMergeSources(AUTO_UPDATE_CONFIG.sources);
      if (uniqueUris.length > 0) {
        let finalUris = AUTO_UPDATE_CONFIG.doRename ? applyRename(uniqueUris) : uniqueUris;
        const profileMetadata = {
          title: AUTO_UPDATE_CONFIG.title,
          interval: AUTO_UPDATE_CONFIG.interval,
          webpage: AUTO_UPDATE_CONFIG.webpage,
          announce: AUTO_UPDATE_CONFIG.announce,
          userinfo: AUTO_UPDATE_CONFIG.userinfo
        };
        const content = buildFile(profileMetadata, finalUris);
        const res = await createOrUpdateFile(cfg, AUTO_UPDATE_CONFIG.targetFilename, content, "Auto update: " + finalUris.length + " nodes");

        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${AUTO_UPDATE_CONFIG.targetFilename}`;
          await sendMessage(cfg.telegramToken, cfg.adminId, `✅ <b>Основной конфиг обновлен!</b>\n\n📡 Серверов: <code>${finalUris.length}</code>\n🔗 <a href="${rawUrl}">Открыть</a>`);
        }
      }
    } catch (e) {
      console.error("[Cron] Main Update Error:", e);
    }

    // 2. Обновление второго конфига (okeania_auto.txt)
    try {
      console.log("[Cron] Decoding secondary source: " + SECONDARY_CONFIG.targetUrl);
      // trusted=true — это наш собственный VPN-воркер (OceaniaVPN), запрос идёт
      // с X-Bot-Secret, минуя проверку "только Happ" на его стороне. БЕЗ этого
      // флага крон получал бы такую же заглушку, что и обычные пользователи.
      const result2 = await decodeSubscription(SECONDARY_CONFIG.targetUrl, true);

      if (result2.ok && result2.uris && result2.uris.length > 0) {
        let finalUris2 = SECONDARY_CONFIG.doRename ? applyRename(result2.uris) : result2.uris;
        const profileMetadata2 = {
          title: SECONDARY_CONFIG.title,
          interval: SECONDARY_CONFIG.interval,
          webpage: SECONDARY_CONFIG.webpage,
          announce: SECONDARY_CONFIG.announce,
          userinfo: SECONDARY_CONFIG.userinfo
        };
        const content2 = buildFile(profileMetadata2, finalUris2);
        const res2 = await createOrUpdateFile(cfg, SECONDARY_CONFIG.targetFilename, content2, "Secondary Auto update: " + finalUris2.length + " nodes");

        if ((res2.content || res2.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl2 = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${SECONDARY_CONFIG.targetFilename}`;
          await sendMessage(cfg.telegramToken, cfg.adminId, `✅ <b>Второй конфиг (Okeania) обновлен!</b>\n\n📡 Серверов: <code>${finalUris2.length}</code>\n🔗 <a href="${rawUrl2}">Открыть</a>`);
        }
        console.log("[Cron] Secondary Success: " + finalUris2.length + " servers saved");
      } else {
        console.error("[Cron] Secondary Failed:", result2.error);
      }
    } catch (e) {
      console.error("[Cron] Secondary Update Error:", e);
    }
  }
};
