import { sendMessage } from "../telegram.js";

export const MAIN_MENU = {
  keyboard: [
    [{ text: "Старт" }, { text: "Рефка" }],
    [{ text: "Поддержка проэкта" }, { text: "Подписка" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Выберите раздел…",
};

export async function showMainMenu(cfg, chatId) {
  return sendMessage(
    cfg.telegramToken,
    chatId,
    "🔑 <b>КлюЧнИк</b>\n\nВыберите нужный раздел в меню ниже.",
    MAIN_MENU,
  );
}

export async function showSubscription(cfg, chatId) {
  return sendMessage(
    cfg.telegramToken,
    chatId,
    "📡 <b>Подписки</b>\n\n" +
      "VIP:\n<code>https://github.com/lsncococososo-rgb/GRN_VPN/raw/refs/heads/main/Vip.txt</code>\n\n" +
      "Обход бс:\n<code>https://github.com/lsncococososo-rgb/GRN_VPN/raw/refs/heads/main/%D0%9E%D0%B1%D1%85%D0%BE%D0%B4%20%D0%B1%D1%81</code>",
    MAIN_MENU,
  );
}

export async function showProjectSupport(cfg, chatId) {
  return sendMessage(
    cfg.telegramToken,
    chatId,
    "💚 <b>Поддержка проэкта</b>\n\n" +
      "Если хотите поддержать развитие проекта, реквизиты:\n\n" +
      "💳 <code>2200701212779232</code>\n\n" +
      "Спасибо за поддержку! ❤️",
    MAIN_MENU,
  );
}

export async function showReferral(cfg, chatId) {
  const username = String(cfg.botUsername || "").replace(/^@/, "").trim();
  const refLink = username
    ? `https://t.me/${username}?start=ref_${chatId}`
    : null;

  return sendMessage(
    cfg.telegramToken,
    chatId,
    "👥 <b>Рефка</b>\n\n" +
      (refLink
        ? `Ваша реферальная ссылка:\n<code>${refLink}</code>\n\nОтправляйте её друзьям, чтобы приглашать их в бота.`
        : "Реферальная система подготовлена, но BOT_USERNAME ещё не задан в переменных Worker."),
    MAIN_MENU,
  );
}
