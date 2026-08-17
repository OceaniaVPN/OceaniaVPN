export const STEPS = ["title", "announce", "webpage", "interval"];

export async function getState(cfg, chatId) {
  return await cfg.kv.get(`state_${chatId}`, "json");
}

export async function setState(cfg, chatId, state) {
  await cfg.kv.put(`state_${chatId}`, JSON.stringify(state), { expirationTtl: 3600 });
}

export async function clearState(cfg, chatId) {
  await cfg.kv.delete(`state_${chatId}`);
}

export const STEP_MSG = {
  title: `📝 <b>Шаг 1/4 — Имя подписки</b>

Как будет называться твоя подписка в приложении?

<i>Пример:</i> <code>🟦StekloVPN whitelist 🦆</code>

Отправь <code>none</code> чтобы пропустить.`,

  announce: `📢 <b>Шаг 2/4 — Описание</b>

Объявление для пользователей (видно в приложении).

<i>Пример:</i> <code>✨ Бесплатный VPN, подпишись @free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  webpage: `🌐 <b>Шаг 3/4 — Ссылка поддержки</b>

Ссылка на канал или поддержку.

<i>Пример:</i> <code>https://t.me/free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  interval: `⏰ <b>Шаг 4/4 — Интервал обновления</b>

Через сколько часов приложение должно обновлять подписку?

<i>Пример:</i> <code>4</code>

Отправь <code>none</code> чтобы пропустить.`,
};
