import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";
import { COUNTRIES } from "./contries.js";

const AUTO_UPDATE_CONFIG = {
  // Ссылка на твой файл со списком источников в GitHub
  sourcesFileUrl: "https://github.com/OceaniaVPN/OceaniaVPN/blob/main/src/sources.txt",
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  doRename: true,
  // Резервные источники, если файл sources.txt еще не создан или недоступен
  fallbackSources: [
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/Vless-Reality-White-Lists-Rus-Mobile.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-CIDR-RU-all.txt?ref_type=heads",
    "https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/WHITE-SNI-RU-all.txt?ref_type=heads",
    "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2"
  ]
};

// 🔥 Функция для извлечения UID из ссылки (для фильтрации дубликатов)
function extractUid(uri) {
  // Ищем паттерн protocol://UUID@...
  const match = uri.match(/^[a-z0-9]+:\/\/([a-f0-9\-]{36})@/i);
  return match ? match[1] : uri; // Если UID не найден, используем всю строку как уникальный ключ
}

// 🔥 Функция скачивания и объединения источников с фильтрацией дубликатов
async function fetchAndMergeSources(sourcesUrls) {
  const allUris = [];
  
  for (const url of sourcesUrls) {
    try {
      const res = await fetch(url.trim(), { method: "GET" });
      if (res.ok) {
        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          // Проверяем, что это валидная VPN ссылка
          if (trimmed && /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(trimmed)) {
            allUris.push(trimmed);
          }
        }
      }
    } catch (e) {
      console.error(`[Auto-Update] Failed to fetch ${url}:`, e.message);
    }
  }
  
  // Фильтрация дубликатов по UID
  const seenUids = new Set();
  const uniqueUris = [];
  
  for (const uri of allUris) {
    const uid = extractUid(uri);
    if (!seenUids.has(uid)) {
      seenUids.add(uid);
      uniqueUris.push(uri);
    }
  }
  
  return uniqueUris;
}

function getSuperscript(n) {
  const sup = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'];
  return n <= 20 ? sup[n] : `#${n}`;
}

function applyRename(uris) {
  const counters = {};
  COUNTRIES.forEach(c => counters[c.name] = 0);
  counters["Рандом"] = 0;

  return uris.map((uri) => {
    const hashIndex = uri.lastIndexOf('#');
    const baseUri = hashIndex === -1 ? uri : uri.substring(0, hashIndex);
    const originalName = hashIndex === -1 ? "" : decodeURIComponent(uri.substring(hashIndex + 1)).toLowerCase();

    let country = null;
    for (const c of COUNTRIES) {
      if (c.keys.some(key => originalName.includes(key))) {
        country = c;
        break;
      }
    }
    
    if (!country) {
      const hostMatch = baseUri.match(/@([^:/]+)/);
      if (hostMatch) {
        const host = hostMatch[1].toLowerCase();
        for (const c of COUNTRIES) {
          if (c.keys.some(key => host.includes(key))) {
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
    const index = counters[counterKey];
    const superscript = getSuperscript(index);

    return `${baseUri}#${encodeURIComponent(`${flag} ${displayName} | БС${superscript}`)}`;
  });
}

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
    const { sourcesFileUrl, fallbackSources, targetFilename, title, interval, webpage, announce, userinfo, doRename } = AUTO_UPDATE_CONFIG;

    try {
      // 1. Пытаемся получить список источников из твоего файла
      let sourcesToUse = fallbackSources;
      try {
        const res = await fetch(sourcesFileUrl, { method: "GET" });
        if (res.ok) {
          const text = await res.text();
          const lines = text.split("\n").map(l => l.trim()).filter(l => l && l.startsWith("http"));
          if (lines.length > 0) {
            sourcesToUse = lines;
            console.log(`[Cron] Loaded ${lines.length} sources from sources.txt`);
          }
        }
      } catch (e) {
        console.log("[Cron] Fallback to default sources due to error:", e.message);
      }

      // 2. Скачиваем, объединяем и фильтруем дубликаты по UID
      const uniqueUris = await fetchAndMergeSources(sourcesToUse);
      console.log(`[Cron] Total unique servers after UID filter: ${uniqueUris.length}`);

      if (uniqueUris.length > 0) {
        let finalUris = uniqueUris;
        if (doRename) {
          finalUris = applyRename(finalUris);
        }

        const profileMetadata = { title, interval, webpage, announce, userinfo };
        const content = buildFile(profileMetadata, finalUris);
        const res = await createOrUpdateFile(cfg, targetFilename, content, "Auto update: " + finalUris.length + " unique nodes");

        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${targetFilename}`;
          await sendMessage(cfg.telegramToken, cfg.adminId, `✅ <b>Авто-обновление успешно!</b>\n\n📡 Уникальных серверов: <code>${finalUris.length}</code>\n🔗 <a href="${rawUrl}">Открыть</a>`);
        }
        console.log("[Cron] Success: " + finalUris.length + " servers saved");
      } else {
        console.error("[Cron] No servers found in any source.");
      }
    } catch (e) {
      console.error("[Cron] Error:", e);
    }
  }
};
