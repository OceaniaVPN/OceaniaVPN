import { cmdStart, handleMessage, handleCallback } from "../commands.js";
import { showMainMenu, showReferral, showProjectSupport, showSubscription } from "./menu.js";

// User-facing command facade. The existing VPN functionality stays in ../commands.js;
// this layer adds the compact КлюЧнИк menu on top of it.
export async function handleCommand(update, cfg) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  if (!chatId) return false;

  const text = String(message?.text || "").trim();
  if (!text) return false;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/help" || text === "Старт") {
    await cmdStart(cfg, chatId);
    await showMainMenu(cfg, chatId);
    return true;
  }

  if (text === "Рефка" || command === "/refka") {
    await showReferral(cfg, chatId);
    return true;
  }

  if (text === "Поддержка проэкта" || command === "/support") {
    await showProjectSupport(cfg, chatId);
    return true;
  }

  if (text === "Подписка" || command === "/subscription") {
    await showSubscription(cfg, chatId);
    return true;
  }

  return false;
}

export { handleMessage, handleCallback };
