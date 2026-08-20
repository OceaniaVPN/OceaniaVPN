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
  doRename: true
};

const COUNTRIES = [
  { keys: ["ru", "russia", "россия", "moscow", "москва", "spb", "peter", "петербург"], flag: "🇷🇺", name: "Россия" },
  { keys: ["de", "germany", "германия", "berlin", "берлин", "frankfurt", "франкфурт", "german"], flag: "🇩🇪", name: "Германия" },
  { keys: ["fi", "finland", "финляндия", "helsinki", "хельсинки", "finnish"], flag: "🇫🇮", name: "Финляндия" },
  { keys: ["lv", "latvia", "латвия", "riga", "рига", "latvian"], flag: "🇱🇻", name: "Латвия" },
  { keys: ["us", "usa", "america", "сша", "new york", "los angeles", "chicago"], flag: "🇺🇸", name: "США" },
  { keys: ["nl", "netherlands", "нидерланды", "amsterdam", "амстердам", "dutch"], flag: "🇳🇱", name: "Нидерланды" },
  { keys: ["gb", "uk", "британия", "london", "лондон", "england", "англия"], flag: "🇬🇧", name: "Великобритания" },
  { keys: ["fr", "france", "франция", "paris", "париж", "french"], flag: "🇫🇷", name: "Франция" },
  { keys: ["ua", "ukraine", "украина", "kiev", "киев", "kyiv"], flag: "🇺🇦", name: "Украина" },
  { keys: ["ee", "estonia", "эстония", "tallinn", "таллин"], flag: "🇪🇪", name: "Эстония" },
  { keys: ["cz", "czech", "чехия", "prague", "прага", "czechia"], flag: "🇨🇿", name: "Чехия" },
  { keys: ["jp", "japan", "япония", "tokyo", "токио"], flag: "🇯🇵", name: "Япония" },
  { keys: ["au", "australia", "австралия", "sydney", "сидней", "melbourne"], flag: "🇦🇺", name: "Австралия" },
  { keys: ["hk", "hong kong", "гонконг", "hongkong"], flag: "🇭🇰", name: "Гонконг" },
  { keys: ["sg", "singapore", "сингапур"], flag: "🇸🇬", name: "Сингапур" },
  { keys: ["kr", "korea", "корея", "seoul", "сеул", "south korea"], flag: "🇰🇷", name: "Южная Корея" },
  { keys: ["it", "italy", "италия", "milan", "милан", "rome", "рим"], flag: "🇮🇹", name: "Италия" },
  { keys: ["es", "spain", "испания", "madrid", "мадрид", "barcelona"], flag: "🇪🇸", name: "Испания" },
  { keys: ["ca", "canada", "канада", "toronto", "торонто", "vancouver"], flag: "🇨🇦", name: "Канада" },
  { keys: ["br", "brazil", "бразилия", "sao paulo", "сан-паулу"], flag: "🇧🇷", name: "Бразилия" },
  { keys: ["in", "india", "индия", "mumbai", "мумбаи", "delhi"], flag: "🇮🇳", name: "Индия" },
  { keys: ["tr", "turkey", "турция", "istanbul", "стамбул"], flag: "🇹🇷", name: "Турция" },
  { keys: ["pl", "poland", "польша", "warsaw", "варшава"], flag: "🇵🇱", name: "Польша" },
  { keys: ["ro", "romania", "румыния", "bucharest", "бухарест"], flag: "🇷🇴", name: "Румыния" },
  { keys: ["kz", "kazakhstan", "казахстан", "almaty", "алматы", "astana"], flag: "🇰🇿", name: "Казахстан" }
];

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
    const counterKey = country ? country.name : "Рандом";

    counters[counterKey]++;
    const index = counters[counterKey];
    const superscript = getSuperscript(index);

    return `${baseUri}#${encodeURIComponent(`${displayName} [БС] ${superscript}`)}`;
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
    const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, doRename } = AUTO_UPDATE_CONFIG;

    try {
      const result = await decodeSubscription(targetUrl);
      if (result.ok && result.uris && result.uris.length > 0) {
        let finalUris = result.uris;
        if (doRename) {
          finalUris = applyRename(finalUris);
        }

        const profileMetadata = { title, interval, webpage, announce, userinfo };
        const content = buildFile(profileMetadata, finalUris);
        const res = await createOrUpdateFile(cfg, targetFilename, content, "Auto update: " + finalUris.length + " nodes");

        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = "https://raw.githubusercontent.com/" + cfg.configRepoOwner + "/" + cfg.configRepoName + "/" + cfg.branch + "/" + cfg.configsFolder + "/" + targetFilename;
          await sendMessage(cfg.telegramToken, cfg.adminId, "✅ Авто-обновление успешно!\n\n📡 Серверов: <code>" + finalUris.length + "</code>\n🔗 <a href=\"" + rawUrl + "\">Открыть</a>");
        }
        console.log("[Cron] Success: " + finalUris.length + " servers saved");
      } else {
        console.error("[Cron] Decode failed:", result.error);
      }
    } catch (e) {
      console.error("[Cron] Error:", e);
    }
  }
};
