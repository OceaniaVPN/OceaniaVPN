import { sendMessage, getTelegramFile } from "./telegram.js";
import { createOrUpdateFile, listProxyFiles } from "./github.js";

function safeProxyName(name) {
  const base = String(name || "subscription.txt").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "subscription.txt";
  return `proxy_${Date.now()}_${base.endsWith(".txt") ? base : base + ".txt"}`;
}

export async function cmdProxy(cfg, chatId) {
  const files = await listProxyFiles(cfg);
  let text = `🌐 <b>ПРОКСИ ПОДПИСОК</b>\n\n`;
  if (!files.length) {
    text += `Пока нет загруженных подписок.\n\n`;
  } else {
    text += `Доступно: <b>${files.length}</b>\n\n`;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const url = `${cfg.workerOrigin}/proxy?f=${encodeURIComponent(f.name)}`;
      text += `<b>${i + 1}.</b> ${f.name.replace(/^proxy_\d+_/, "")}\n🔗 <code>${url}</code>\n\n`;
    }
  }
  if (chatId === cfg.adminId) {
    text += `👑 <b>Админ:</b> просто отправь сюда файл подписки документом — он появится в общем каталоге.`;
  } else {
    text += `📥 Ссылки выше доступны всем пользователям.`;
  }
  return sendMessage(cfg.telegramToken, chatId, text, {
    inline_keyboard: [
      [{ text: "🔄 Обновить список", callback_data: "proxy" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }],
    ],
  });
}

export async function handleProxyDocument(cfg, msg) {
  const chatId = msg.chat.id;
  if (chatId !== cfg.adminId || msg.from?.id !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, `⛔️ <b>Загрузка прокси доступна только администратору.</b>`);
  }
  const document = msg.document;
  if (!document?.file_id) return sendMessage(cfg.telegramToken, chatId, `❌ Файл не найден.`);
  if ((document.file_size || 0) > 1024 * 1024) {
    return sendMessage(cfg.telegramToken, chatId, `❌ Файл слишком большой. Максимум: <b>1 МБ</b>.`);
  }
  const content = await getTelegramFile(cfg.telegramToken, document.file_id);
  if (content == null) return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось скачать файл из Telegram.`);
  if (!content.trim()) return sendMessage(cfg.telegramToken, chatId, `❌ Файл пустой.`);
  const filename = safeProxyName(document.file_name);
  const res = await createOrUpdateFile(cfg, filename, content, `Upload proxy subscription ${document.file_name || filename}`);
  if (!(res.content || res.sha)) return sendMessage(cfg.telegramToken, chatId, `❌ Не удалось сохранить прокси: ${res.message || "GitHub error"}`);
  const url = `${cfg.workerOrigin}/proxy?f=${encodeURIComponent(filename)}`;
  return sendMessage(cfg.telegramToken, chatId,
    `✅ <b>Прокси подписка опубликована</b>\n\n📄 ${document.file_name || "subscription.txt"}\n🔗 <code>${url}</code>\n\n👥 Теперь ссылку может использовать любой пользователь.`,
    { inline_keyboard: [[{ text: "🌐 Открыть прокси", url }], [{ text: "📚 Каталог прокси", callback_data: "proxy" }]] });
}
