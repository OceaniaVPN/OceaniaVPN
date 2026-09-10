import { handleCommand, handleMessage, handleCallback } from "./commands.js";

export async function handleUpdate(update, cfg) {
  if (!update) return false;

  if (await handleCommand(update, cfg)) return true;

  if (update.callback_query) {
    await handleCallback(cfg, update.callback_query);
    return true;
  }

  if (update.message) {
    await handleMessage(cfg, update.message);
    return true;
  }

  return false;
}
