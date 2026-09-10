import { cmdStart, handleMessage, handleCallback } from "../commands.js";

// Thin command facade: business logic remains in the existing implementation
// while the bot grows toward the modular CDZ-Bot layout.
export async function handleCommand(update, cfg) {
  const message = update?.message;
  const text = String(message?.text || "").trim();
  if (!text.startsWith("/")) return false;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/help") {
    await cmdStart(cfg, message.chat.id);
    return true;
  }
  return false;
}

export { handleMessage, handleCallback };
