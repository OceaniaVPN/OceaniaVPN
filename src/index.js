import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";

export default {
  // 1. Обработка обычных HTTP запросов (Telegram Webhook)
  async fetch(request, env) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    
    if (request.method === "GET") {
      if (url.pathname === "/") {
        return new Response(
          `<!DOCTYPE html><html><head><title>OceaniaVPN</title><style>body{font-family:system-ui;max-width:600px;margin:50px auto;padding:20px;background:#0a0e27;color:#fff;text-align:center}.logo{font-size:60px;margin-bottom:20px}h1{background:linear-gradient(90deg,#00d4ff,#0099ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}</style></head><body><div class="logo">🌊</div><h1>OceaniaVPN Bot</h1><p>🚀 Активен и готов к работе</p><p>🥷 Декодер подписок с маскировкой под Happ</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
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
        if (update.callback_query) {
          await handleCallback(cfg, update.callback_query);
        } else if (update.message) {
          await handleMessage(cfg, update.message);
        }
        return new Response("OK", { status: 200 });
      } catch (e) {
        console.error(e);
        return new Response(`Error: ${e.message}`, { status: 500 });
      }
    }
    return new Response("Method not allowed", { status: 405 });
  },

  // 2. АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ ПО РАСПИСАНИЮ (КАЖДЫЙ ЧАС)
  async scheduled(event, env, ctx) {
    const cfg = getConfig(env);
    
    // 🔧 НАСТРОЙКИ АВТО-ОБНОВЛЕНИЯ
    const targetUrl = "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2";
    // ВАЖНО: Используй стабильное имя файла, чтобы он ПЕРЕЗАПИСЫВАЛСЯ, а не создавался новый каждый час!
    // Если хочешь другое имя, поменяй "auto_sub_5512307834.txt" на нужное (например, то, что было на скриншоте)
    const targetFilename = "auto_sub_5512307834.txt"; 
    
    // Настройки профиля (как в гайде по созданию)
    const profileMetadata = {
      title: "🔑 Авто-обновление AccarGame",
      interval: 1, // Обновление каждые 1 час
      webpage: targetUrl,
      announce: "🤖 Автоматически обновляется каждый час"
    };

    try {
      console.log(`[Auto-Update] Starting decode for: ${targetUrl}`);
      
      // 1. Декодируем ссылку
      const result = await decodeSubscription(targetUrl);
      
      if (result.ok && result.uris && result.uris.length > 0) {
        // 2. Формируем файл с заголовками
        const content = buildFile(profileMetadata, result.uris);
        
        // 3. Сохраняем/обновляем файл на GitHub
        const res = await createOrUpdateFile(cfg, targetFilename, content, `Auto hourly update: ${result.uris.length} nodes`);
        
        if (res.content || res.sha) {
          console.log(`[Auto-Update] Success! File ${targetFilename} updated with ${result.uris.length} nodes.`);
          
          // (Опционально) Уведомление админу об успехе
          if (cfg.adminId) {
            const rawUrl = `https://raw.githubusercontent.com/${cfg.configRepoOwner}/${cfg.configRepoName}/${cfg.branch}/${cfg.configsFolder}/${targetFilename}`;
            await sendMessage(
              cfg.telegramToken, 
              cfg.adminId, 
              `✅ <b>Авто-обновление успешно!</b>\n\n📡 Серверов: <code>${result.uris.length}</code>\n📁 Файл: <code>${targetFilename}</code>\n🔗 <a href="${rawUrl}">Ссылка на файл</a>`
            );
          }
        } else {
          console.error(`[Auto-Update] GitHub save failed:`, res);
        }
      } else {
        console.error(`[Auto-Update] Decode failed:`, result.error);
        if (cfg.adminId) {
          await sendMessage(cfg.telegramToken, cfg.adminId, `⚠️ <b>Ошибка авто-обновления</b>\n\nНе удалось декодировать ссылку.\nПричина: ${result.error}`);
        }
      }
    } catch (e) {
      console.error(`[Auto-Update] Critical error:`, e);
    }
  }
};
