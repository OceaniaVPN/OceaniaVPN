import { getConfig } from "./config.js";
import { handleCallback, handleMessage } from "./commands.js";

export default {
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
};
