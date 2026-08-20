import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";
import { COUNTRIES } from "./contries.js";

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

// 🔥 ИСПОЛЬЗУЕМ УМНЫЙ ДЕКОДЕР ВМЕСТО ПРОСТОГО FETCH
async function fetchAndMergeSources(sourcesUrls) {
  const allUris = [];
  const stats = {};
  
  for (const url of sourcesUrls) {
    try {
      console.log(`[Merge] Decoding source: ${url}`);
      const result = await decodeSubscription(url);
      
      if (result.ok && result.uris && result.uris.length > 0) {
        allUris.push(...result.uris);
        stats[url] = result.uris.length;
        console.log(`[Merge] Success: Found ${result.uris.length} URIs`);
      } else {
        stats[url] = 0;
        console.log(`[Merge] Failed or empty: ${result.error}`);
      }
    } catch (e) {
      console.error(`[Merge] Error on ${url}:`, e.message);
      stats[url] = 0;
    }
  }
  
  const uniqueUris = [...new Set(allUris)];
  console.log(`[Merge] Total URIs: ${allUris.length}, After dedup: ${uniqueUris.length}`);
  return { uris: uniqueUris, stats };
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
    const superscript = getSuperscript(counters[counterKey]);
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
    const { sources, targetFilename, title, interval, webpage, announce, userinfo, doRename } = AUTO_UPDATE_CONFIG;

    try {
      const { uris: uniqueUris, stats } = await fetchAndMergeSources(sources);
      
      if (uniqueUris.length > 0) {
        let finalUris = doRename ? applyRename(uniqueUris) : uniqueUris;
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
