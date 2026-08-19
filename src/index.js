import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";

const AUTO_UPDATE_CONFIG = {
  targetUrl: "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "Steklo vpn besplatno",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  renameServers: true
};

const COUNTRIES = [
  { keys: ["us", "usa", "america", "new york", "los angeles"], flag: "🇸", name: "США" },
  { keys: ["ru", "russia", "moscow", "spb", "peter"], flag: "🇷🇺", name: "Россия" },
  { keys: ["de", "germany", "berlin", "frankfurt"], flag: "🇩🇪", name: "Германия" },
  { keys: ["nl", "netherlands", "amsterdam"], flag: "🇳🇱", name: "Нидерланды" },
  { keys: ["gb", "uk", "london", "england"], flag: "🇬🇧", name: "Великобритания" },
  { keys: ["fr", "france", "paris"], flag: "🇫🇷", name: "Франция" },
  { keys: ["fi", "finland", "helsinki"], flag: "🇫🇮", name: "Финляндия" },
  { keys: ["kz", "kazakhstan", "almaty", "astana"], flag: "🇰", name: "Казахстан" },
  { keys: ["ua", "ukraine", "kiev"], flag: "🇺🇦", name: "Украина" },
  { keys: ["jp", "japan", "tokyo"], flag: "🇯🇵", name: "Япония" },
  { keys: ["sg", "singapore"], flag: "🇸", name: "Сингапур" },
  { keys: ["kr", "korea", "seoul"], flag: "🇰", name: "Корея" },
  { keys: ["it", "italy", "milan", "rome"], flag: "🇹", name: "Италия" },
  { keys: ["es", "spain", "madrid", "barcelona"], flag: "🇪🇸", name: "Испания" },
  { keys: ["ca", "canada", "toronto", "vancouver"], flag: "🇨🇦", name: "Канада" },
  { keys: ["au", "australia", "sydney", "melbourne"], flag: "🇦🇺", name: "Австралия" },
  { keys: ["br", "brazil", "sao paulo"], flag: "🇧", name: "Бразилия" },
  { keys: ["in", "india", "mumbai", "delhi"], flag: "🇳", name: "Индия" },
  { keys: ["tr", "turkey", "istanbul"], flag: "🇹", name: "Турция" },
  { keys: ["pl", "poland", "warsaw"], flag: "🇵", name: "Польша" }
];

const SUP = ['', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹⁶', '¹⁷', '¹⁸', '¹⁹', '²⁰'];

function renameServers(uris) {
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

    let displayName, counterKey;
    if (country) {
      displayName = country.flag + " " + country.name;
      counterKey = country.name;
    } else {
      displayName = "Рандом";
      counterKey = "Рандом";
    }

    counters[counterKey]++;
    const index = counters[counterKey];
    const superscript = SUP[Math.min(index, 20)] || ("_" + index);

    return baseUri + "#" + encodeURIComponent(displayName + " | БС" + superscript);
  });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response("OceaniaVPN Bot OK", {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      if (url.pathname === "/debug-auto-update") {
        try {
          const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, renameServers } = AUTO_UPDATE_CONFIG;

          const result = await decodeSubscription(targetUrl);

          if (!result.ok) {
            return new Response("ERROR: " + result.error, {
              headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
          }

          let finalUris = result.uris;
          if (renameServers && finalUris.length > 0) {
            finalUris = renameServers(finalUris);
          }

          const profileMetadata = { title, interval, webpage, announce, userinfo };
          const content = buildFile(profileMetadata, finalUris);
          const saveResult = await createOrUpdateFile(cfg, targetFilename, content, "Debug update");

          return new Response("OK! Servers: " + result.uris.length + "\n\nFirst 3:\n" + finalUris.slice(0, 3).join("\n"), {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });

        } catch (e) {
          return new Response("ERROR: " + e.message, {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
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
        if (update.callback_query) {
          await handleCallback(cfg, update.callback_query);
        } else if (update.message) {
          await handleMessage(cfg, update.message);
        }
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("Error: " + e.message, { status: 500 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },

  async scheduled(event, env, ctx) {
    const cfg = getConfig(env);
    const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, renameServers } = AUTO_UPDATE_CONFIG;

    try {
      const result = await decodeSubscription(targetUrl);
      if (result.ok && result.uris && result.uris.length > 0) {
        let finalUris = result.uris;
        if (renameServers) {
          finalUris = renameServers(finalUris);
        }

        const profileMetadata = { title, interval, webpage, announce, userinfo };
        const content = buildFile(profileMetadata, finalUris);
        const res = await createOrUpdateFile(cfg, targetFilename, content, "Auto update");

        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + targetFilename;
          await sendMessage(cfg.telegramToken, cfg.adminId, "Auto-update OK! Servers: " + finalUris.length);
        }
      }
    } catch (e) {
      console.error("Auto-update error:", e);
    }
  }
};
