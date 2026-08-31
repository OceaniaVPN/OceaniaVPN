import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";
import { COUNTRIES } from "./contries.js";

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
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads"
  ]
};

// ==========================================
// ВТОРАЯ КОНФИГУРАЦИЯ (Только одна ссылка)
// ==========================================
const SECONDARY_CONFIG = {
  targetUrl: "https://okeaniavpn.dimastekolnikov1.workers.dev/sub?token=0fe191f6-7ec7-44ec-aed7-cc6423745ca8",
  targetFilename: "okeania_auto.txt",
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

// ✅ ИСПРАВЛЕНИЕ: Безопасная проверка ключей (чтобы "ro" не триггерилось на "proxy" или "trojan")
function matchesCountryKey(text, key) {
  if (key.length <= 2) {
    // Для коротких ключей (ru, ro, in и т.д.) требуем, чтобы они были отдельным словом
    const regex = new RegExp(`(^|[^a-zа-яё0-9])${key}([^a-zа-яё0-9]|$)`);
    return regex.test(text);
  }
  return text.includes(key);
}

function applyRename(uris) {
  const counters = {};
  COUNTRIES.forEach(function(c) { counters[c.name] = 0; });
  counters["Рандом"] = 0;

  return uris.map(function(uri) {
    const hashIndex = uri.lastIndexOf('#');
    const baseUri = hashIndex === -1 ? uri : uri.substring(0, hashIndex);
    const originalName = hashIndex === -1 ? "" : decodeURIComponent(uri.substring(hashIndex + 1)).toLowerCase();

    let country = null;
    
    // 1. Сначала проверяем имя (remark) после #
    for (const c of COUNTRIES) {
      if (c.keys.some(function(key) { return matchesCountryKey(originalName, key); })) {
        country = c;
        break;
      }
    }
    
    // 2. Если не нашли, проверяем хост (домен или IP после @)
    if (!country) {
      const hostMatch = baseUri.match(/@([^:/]+)/);
      if (hostMatch) {
        const host = hostMatch[1].toLowerCase();
        for (const c of COUNTRIES) {
          if (c.keys.some(function(key) { return matchesCountryKey(host, key); })) {
            country = c;
            break;
          }
        }
      }
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
// ОСНОВНОЙ ЭКСПОРТ WORKER
// ==========================================

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response("OceaniaVPN Bot OK", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
