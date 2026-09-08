import app from "./index.js";
import { getConfig } from "./config.js";
import { getFileContent } from "./github.js";
import { cmdProxy, handleProxyDocument } from "./proxy.js";

async function servePublicProxy(request, cfg) {
  const url = new URL(request.url);
  const filename = url.searchParams.get("f") || "";
  if (!/^proxy_[A-Za-z0-9._-]+\.txt$/.test(filename)) {
    return new Response("Proxy file not found", { status: 404 });
  }
  const content = await getFileContent(cfg, filename);
  if (!content) return new Response("Proxy file not found", { status: 404 });
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cfg = getConfig(env);
    const url = new URL(request.url);
    if (!cfg.workerOrigin) cfg.workerOrigin = url.origin;

    if (request.method === "GET" && url.pathname === "/proxy") {
      return servePublicProxy(request, cfg);
    }

    if (request.method === "POST") {
      try {
        const update = await request.clone().json();
        if (update.message?.document) {
          await handleProxyDocument(cfg, update.message);
          return new Response("OK", { status: 200 });
        }
        if (update.callback_query?.data === "proxy") {
          await cmdProxy(cfg, update.callback_query.message.chat.id);
          return new Response("OK", { status: 200 });
        }
        if (update.message?.text?.trim() === "/proxy") {
          await cmdProxy(cfg, update.message.chat.id);
          return new Response("OK", { status: 200 });
        }
      } catch {
        // Fall through to the normal worker webhook handler.
      }
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === "function") return app.scheduled(event, env, ctx);
  },
};
