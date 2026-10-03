import app from "./index.js";
import { getConfig } from "./config.js";
import { getFileContent } from "./github.js";

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

    // This wrapper owns only the public /proxy file route.
    // All Telegram webhook POST updates must go through the single canonical
    // handler in src/index.js so callback_query is acknowledged, deduplicated,
    // and processed consistently.
    if (request.method === "GET" && url.pathname === "/proxy") {
      return servePublicProxy(request, cfg);
    }

    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === "function") return app.scheduled(event, env, ctx);
  },
};
