import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";

// 🔧 ТОЧНЫЕ НАСТРОЙКИ АВТО-ОБНОВЛЕНИЯ (как в твоем примере)
const AUTO_UPDATE_CONFIG = {
  targetUrl: "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
  targetFilename: "whitelist.txt", // Имя файла, как ты просил
  
  // Точные заголовки из твоего примера
  title: "🟦Steklo_VPN whitelist 🦆",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "✨ 🟦Стекло впн бесплатно поддержите наш канал @free_vpn123456 донатом а если ник будет утка то 50% от доната пойдет на корм уткам",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  
  // 🔥 УМНОЕ ПЕРЕИМЕНОВАНИЕ С ФЛАГАМИ СТРАН
  renameServers: true,
};

// 🔥 ФУНКЦИЯ ДОБАВЛЕНИЯ ФЛАГОВ СТРАН
function addCountryFlags(uris) {
  // Словарь соответствий: ключевые слова в исходном имени -> Флаг + Название
  const countryMap = [
    { keys: ["ru", "russia", "россия", "москва", "moscow", "spb", "peter"], flag: "🇷🇺", name: "Russia" },
    { keys: ["us", "usa", "america", "сша", "нью-йорк", "new york"], flag: "🇺🇸", name: "USA" },
    { keys: ["de", "germany", "германия", "берлин", "berlin", "german"], flag: "🇩🇪", name: "Germany" },
    { keys: ["nl", "netherlands", "нидерланды", "amsterdam"], flag: "🇳🇱", name: "Netherlands" },
    { keys: ["gb", "uk", "england", "британия", "london", "london"], flag: "🇬🇧", name: "UK" },
    { keys: ["fr", "france", "франция", "paris"], flag: "🇫🇷", name: "France" },
    { keys: ["fi", "finland", "финляндия"], flag: "🇫🇮", name: "Finland" },
    { keys: ["kz", "kazakhstan", "казахстан"], flag: "🇰🇿", name: "Kazakhstan" },
  ];

  return uris.map((uri, index) => {
    const hashIndex = uri.lastIndexOf('#');
    if (hashIndex === -1) return `${uri}#🌍 Server #${index + 1}`; // Запасной вариант
    
    const baseUri = uri.substring(0, hashIndex);
    const originalName = decodeURIComponent(uri.substring(hashIndex + 1)).toLowerCase();
    
    // Ищем совпадение страны
    let newName = `🌍 Server #${index + 1}`; // По умолчанию
    for (const country of countryMap) {
      if (country.keys.some(key => originalName.includes(key))) {
        newName = `${country.flag} ${country.name} #${index + 1}`;
        break;
      }
    }
    
    return `${baseUri}#${encodeURIComponent(newName)}`;
  });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><title>OceaniaVPN</title><style>body{font-family:system-ui;max-width:600px;margin:50px auto;padding:20px;background:#0a0e27;color:#fff;text-align:center}.logo{font-size:60px;margin-bottom:20px}h1{background:linear-gradient(90deg,#00d4ff,#0099ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head><body><div class="logo">🌊</div><h1>OceaniaVPN Bot</h1><p>🚀 Активен и готов к работе</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      
      // 🔥 РУЧНОЙ ЗАПУСК И ПРОВЕРКА
      if (url.pathname === "/debug-auto-update") {
        try {
          const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, renameServers } = AUTO_UPDATE_CONFIG;
          
          const result = await decodeSubscription(targetUrl);
          if (!result.ok) {
            return new Response(`❌ ОШИБКА ДЕКОДИРОВАНИЯ:\n\n${result.error}`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }

          let finalUris = result.uris;
          if (renameServers) {
            finalUris = addCountryFlags(result.uris);
          }

          const profileMetadata = { title, interval, webpage, announce, userinfo };
          const content = buildFile(profileMetadata, finalUris);
          const saveResult = await createOrUpdateFile(cfg, targetFilename, content, `Auto update: ${finalUris.length} nodes`);

          let tgStatus = "Не отправлено (проверьте ADMIN_ID)";
          if (cfg.adminId && cfg.adminId > 0) {
            try {
              const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${targetFilename}`;
              await sendMessage(cfg.telegramToken, cfg.adminId, `✅ <b>Авто-обновление успешно!</b>\n\n📡 Серверов: <code>${finalUris.length}</code>\n📁 Файл: <code>${targetFilename}</code>\n🔗 <a href="${rawUrl}">Открыть</a>`);
              tgStatus = "✅ Сообщение отправлено в Telegram";
            } catch (tgError) {
              tgStatus = `❌ Ошибка Telegram: ${tgError.message}`;
            }
          }

          return new Response(`✅ УСПЕХ!\n\n📡 Найдено серверов: ${result.uris.length}\n🏳️ Переименованы с флагами: ${renameServers ? 'Да' : 'Нет'}\n💾 GitHub ответ: ${JSON.stringify(saveResult)}\n📱 Telegram: ${tgStatus}\n\n📄 Начало файла:\n${content.substring(0, 600)}`, {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });

        } catch (e) {
          return new Response(`💥 КРИТИЧЕСКАЯ ОШИБКА:\n${e.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
      }
      
      if (url.pathname === "/set-webhook") {
        const workerUrl = `${url.protocol}//${url.host}`;
        const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/setWebhook?url=${workerUrl}`, { method: "POST" });
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
        return new Response(`Error: ${e.message}`, { status: 500 });
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
          finalUris = addCountryFlags(result.uris);
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
