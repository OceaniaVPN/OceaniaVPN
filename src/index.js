import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";

const AUTO_UPDATE_CONFIG = {
  targetUrl: "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
  targetFilename: "whitelist.txt",
  title: "Steklo_VPN whitelist 🦆",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "✨ 🟦Стекло впн бесплатно поддержите наш канал @free_vpn123456 донатом а если ник будет утка то 50% от доната пойдет на корм уткам",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  renameServers: true
};

const COUNTRIES = [
  { keys: ["us", "usa", "америка", "сша", "united states", "new york", "los angeles", "chicago"], flag: "🇸", name: "США" },
  { keys: ["ru", "russia", "россия", "moscow", "москва", "spb", "peter", "петербург"], flag: "🇷🇺", name: "Россия" },
  { keys: ["de", "germany", "германия", "berlin", "берлин", "frankfurt", "франкфурт"], flag: "🇪", name: "Германия" },
  { keys: ["nl", "netherlands", "нидерланды", "amsterdam", "амстердам"], flag: "🇳🇱", name: "Нидерланды" },
  { keys: ["gb", "uk", "британия", "london", "лондон", "england", "англия"], flag: "🇬🇧", name: "Великобритания" },
  { keys: ["fr", "france", "франция", "paris", "париж"], flag: "🇫🇷", name: "Франция" },
  { keys: ["fi", "finland", "финляндия", "helsinki", "хельсинки"], flag: "🇫🇮", name: "Финляндия" },
  { keys: ["kz", "kazakhstan", "казахстан", "almaty", "алматы", "astana", "астана"], flag: "🇰🇿", name: "Казахстан" },
  { keys: ["ua", "ukraine", "украина", "kiev", "киев"], flag: "🇺🇦", name: "Украина" },
  { keys: ["jp", "japan", "япония", "tokyo", "токио"], flag: "🇯🇵", name: "Япония" },
  { keys: ["sg", "singapore", "сингапур"], flag: "🇸🇬", name: "Сингапур" },
  { keys: ["kr", "korea", "корея", "seoul", "сеул"], flag: "🇰🇷", name: "Южная Корея" },
  { keys: ["it", "italy", "италия", "milan", "милан", "rome", "рим"], flag: "🇮🇹", name: "Италия" },
  { keys: ["es", "spain", "испания", "madrid", "мадрид", "barcelona", "барселона"], flag: "🇸", name: "Испания" },
  { keys: ["ca", "canada", "канада", "toronto", "торонто", "vancouver", "ванкувер"], flag: "🇨🇦", name: "Канада" },
  { keys: ["au", "australia", "австралия", "sydney", "сидней", "melbourne", "мельбурн"], flag: "🇺", name: "Австралия" },
  { keys: ["br", "brazil", "бразилия", "sao paulo", "сан-паулу"], flag: "🇧🇷", name: "Бразилия" },
  { keys: ["in", "india", "индия", "mumbai", "мумбаи", "delhi", "дели"], flag: "🇮🇳", name: "Индия" },
  { keys: ["tr", "turkey", "турция", "istanbul", "стамбул"], flag: "🇹🇷", name: "Турция" },
  { keys: ["pl", "poland", "польша", "warsaw", "варшава"], flag: "🇵🇱", name: "Польша" }
];

const SUPERSCRIPTS = ['', '¹', '²', '³', '⁴', '', '⁶', '⁷', '', '⁹', '¹⁰', '¹¹', '¹²', '¹³', '¹⁴', '¹⁵', '¹', '¹⁷', '¹⁸', '¹⁹', '²⁰'];

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
      displayName = `${country.flag} ${country.name}`;
      counterKey = country.name;
    } else {
      displayName = "Рандом";
      counterKey = "Рандом";
    }

    counters[counterKey]++;
    const index = counters[counterKey];
    const superscript = SUPERSCRIPTS[Math.min(index, 20)] || `_${index}`;

    return `${baseUri}#${encodeURIComponent(`${displayName} | БС${superscript}`)}`;
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname === "/") {
      return new Response("🌊 OceaniaVPN Bot работает!", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (url.pathname === "/debug-auto-update") {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const cfg = getConfig(env);
        const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, renameServers } = AUTO_UPDATE_CONFIG;

        const result = await decodeSubscription(targetUrl);
        clearTimeout(timeoutId);

        if (!result.ok) {
          return new Response(`❌ ОШИБКА ДЕКОДИРОВАНИЯ:\n\n${result.error}`, {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }

        let finalUris = result.uris;
        if (renameServers && finalUris.length > 0) {
          finalUris = renameServers(finalUris);
        }

        const profileMetadata = { title, interval, webpage, announce, userinfo };
        const content = buildFile(profileMetadata, finalUris);
        const saveResult = await createOrUpdateFile(cfg, targetFilename, content, `Debug update`);

        return new Response(`✅ УСПЕХ!\n\n📡 Найдено серверов: ${result.uris.length}\n💾 GitHub: ${saveResult.content ? 'OK' : JSON.stringify(saveResult)}\n\n Первые 5 строк серверов:\n${finalUris.slice(0, 5).join('\n')}`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });

      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          return new Response(`️ ТАЙМАУТ (15 сек)!\n\nСервер блокирует Cloudflare.`, {
            status: 504,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
        return new Response(`💥 ОШИБКА:\n${e.message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    if (url.pathname === "/set-webhook") {
      const cfg = getConfig(env);
      const workerUrl = `${url.protocol}//${url.host}`;
      const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setWebhook?url=${workerUrl}`, { method: "POST" });
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST") {
      try {
        const cfg = getConfig(env);
        const update = await request.json();
        if (update.callback_query) await handleCallback(cfg, update.callback_query);
        else if (update.message) await handleMessage(cfg, update.message);
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
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
        const res = await createOrUpdateFile(cfg, targetFilename, content, `Auto update: ${finalUris.length} nodes`);
        
        if ((res.content || res.sha) && cfg.adminId && cfg.adminId > 0) {
          const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${targetFilename}`;
          await sendMessage(cfg.telegramToken, cfg.adminId, `✅ <b>Авто-обновление успешно!</b>\n\n📡 Серверов: <code>${finalUris.length}</code>\n📁 Файл: <code>${targetFilename}</code>\n🔗 <a href="${rawUrl}">Открыть</a>`);
        }
      }
    } catch (e) {
      console.error(`[Auto-Update] Error:`, e);
    }
  }
};
