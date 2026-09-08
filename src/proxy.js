import { sendMessage } from "./telegram.js";
import { createOrUpdateFile, getFileContent } from "./github.js";

const PROXY_LINKS_FILE = "proxy_links.txt";

function normalizeProxyLink(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const isTelegramHost = host === "t.me" || host === "telegram.me" || host === "www.t.me" || host === "www.telegram.me";
    if (u.protocol === "https:" && isTelegramHost && u.pathname === "/proxy") return u.toString();
  } catch {
    if (/^tg:\/\/proxy\?/i.test(raw)) return raw;
  }
  return null;
}

async function readProxyLinks(cfg) {
  const content = await getFileContent(cfg, PROXY_LINKS_FILE);
  if (!content) return [];
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function addProxyLink(cfg, chatId, input) {
  if (chatId !== cfg.adminId) {
    return sendMessage(cfg.telegramToken, chatId, `⛔️ <b>Добавлять Telegram-прокси может только администратор.</b>`);
  }

  const link = normalizeProxyLink(input);
  if (!link) {
    return sendMessage(cfg.telegramToken, chatId,
      `❌ <b>Это не ссылка Telegram-прокси.</b>\n\n` +
      `Отправь ссылку вида:\n<code>https://t.me/proxy?server=...&port=...&secret=...</code>`);
  }

  const links = await readProxyLinks(cfg);
  if (links.includes(link)) {
    return sendMessage(cfg.telegramToken, chatId, `ℹ️ <b>Эта прокси-ссылка уже есть в списке.</b>`, {
      inline_keyboard: [[{ text: "🌐 Открыть прокси", url: link }], [{ text: "📚 Список прокси", callback_data: "proxy" }]],
    });
  }

  links.push(link);
  const content = links.join("\n") + "\n";
  const res = await createOrUpdateFile(cfg, PROXY_LINKS_FILE, content, "Add Telegram proxy link");
  if (!(res.content || res.commit || res.sha)) {
    return sendMessage(cfg.telegramToken, chatId, `❌ <b>Не удалось сохранить прокси.</b>\n\n${res.message || "GitHub error"}`);
  }

  return sendMessage(cfg.telegramToken, chatId, `✅ <b>Telegram-прокси добавлен</b>\n\n🔗 <code>${link}</code>\n\n👥 Теперь он отображается в общем списке для всех пользователей.`, {
    inline_keyboard: [[{ text: "🌐 Открыть прокси", url: link }], [{ text: "📚 Список прокси", callback_data: "proxy" }]],
  });
}

export async function cmdProxy(cfg, chatId) {
  const links = await readProxyLinks(cfg);
  let text = `🌐 <b>TELEGRAM-ПРОКСИ</b>\n\n`;

  if (!links.length) {
    text += `Пока нет добавленных прокси.\n\n`;
  } else {
    text += `Доступно: <b>${links.length}</b>\n\n`;
    for (let i = 0; i < links.length; i++) {
      text += `<b>${i + 1}.</b> Telegram Proxy\n🔗 <code>${links[i]}</code>\n\n`;
    }
  }

  if (chatId === cfg.adminId) {
    text += `👑 <b>Админ:</b> просто отправь сюда ссылку на Telegram-прокси — она добавится в этот список.`;
  } else {
    text += `📥 Все ссылки из списка доступны пользователям.`;
  }

  return sendMessage(cfg.telegramToken, chatId, text, {
    inline_keyboard: [
      [{ text: "🔄 Обновить список", callback_data: "proxy" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }],
    ],
  });
}
