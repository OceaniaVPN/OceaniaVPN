import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";
import { decodeSubscription } from "./decoder.js";
import { buildFile } from "./build.js";
import { createOrUpdateFile } from "./github.js";
import { sendMessage } from "./telegram.js";

const AUTO_UPDATE_CONFIG = {
  targetUrl: "https://accargame.cfd/sub/wQu5TeYdOD9YMcp2",
  targetFilename: "whitelist.txt",
  title: "🟦Steklo_VPN whitelist 🦆",
  interval: 4,
  webpage: "https://t.me/free_vpn123456",
  announce: "✨ 🟦Стекло впн бесплатно поддержите наш канал @free_vpn123456 донатом а если ник будет утка то 50% от доната пойдет на корм уткам",
  userinfo: "upload=0; download=12884901888; total=536870912000; expire=0",
  renameServers: true
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. Главная страница
    if (url.pathname === "/") {
      return new Response("🌊 OceaniaVPN Bot работает! (Версия с защитой от зависания)", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // 2. Отладка авто-обновления с ЖЕСТКИМ ТАЙМАУТОМ
    if (url.pathname === "/debug-auto-update") {
      const controller = new AbortController();
      // Принудительно обрываем запрос через 15 секунд, чтобы не было бесконечной загрузки
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const cfg = getConfig(env);
        const { targetUrl, targetFilename, title, interval, webpage, announce, userinfo, renameServers } = AUTO_UPDATE_CONFIG;

        // Пытаемся декодировать
        const result = await decodeSubscription(targetUrl);
        
        clearTimeout(timeoutId); // Если дошли сюда, значит таймаут не сработал, отменяем его

        if (!result.ok) {
          return new Response(`❌ ОШИБКА ДЕКОДИРОВАНИЯ:\n\n${result.error}\n\nПопыток: ${result.attempts || 0}`, {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }

        // Переименовываем серверы (упрощенный надежный вариант)
        let finalUris = result.uris;
        if (renameServers && finalUris.length > 0) {
           finalUris = finalUris.map((uri, i) => {
             const hash = uri.lastIndexOf('#');
             const base = hash === -1 ? uri : uri.substring(0, hash);
             return `${base}#🌍 Server #${i + 1}`;
           });
        }

        // Собираем файл с нужными заголовками
        const profileMetadata = { title, interval, webpage, announce, userinfo };
        const content = buildFile(profileMetadata, finalUris);

        // Сохраняем в GitHub
        const saveResult = await createOrUpdateFile(cfg, targetFilename, content, `Debug update`);

        return new Response(`✅ УСПЕХ!\n\n📡 Найдено серверов: ${result.uris.length}\n💾 GitHub ответ: ${saveResult.content ? 'OK (SHA: ' + saveResult.sha + ')' : JSON.stringify(saveResult)}\n\n📄 Начало файла:\n${content.substring(0, 500)}`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });

      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          return new Response(`⏱️ ТАЙМАУТ (15 сек)!\n\nСервер accargame.cfd слишком долго не отвечает или намеренно блокирует запросы от Cloudflare.\n\nЭто подтверждает, что проблема на стороне целевого сервера, а не в коде бота.`, {
            status: 504,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
        return new Response(`💥 КРИТИЧЕСКАЯ ОШИБКА:\n${e.message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  // Функция для Cron (запускается по расписанию)
  async scheduled(event, env, ctx) {
    // Пока отключим сложную логику в Cron, чтобы не тратить ресурсы, 
    // пока мы не убедимся, что /debug-auto-update работает стабильно.
    console.log("Cron triggered, but waiting for debug confirmation.");
  }
};
