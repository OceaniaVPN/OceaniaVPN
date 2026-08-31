export const STEPS = ["title", "announce", "webpage", "interval", "expireDays"];

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
  title: `📝 <b>Шаг 1/5 — Имя подписки</b>

Как будет называться твоя подписка в приложении?

<i>Пример:</i> <code>🟦StekloVPN whitelist 🦆</code>

Отправь <code>none</code> чтобы пропустить.`,

  announce: `📢 <b>Шаг 2/5 — Описание</b>

Объявление для пользователей (видно в приложении).

<i>Пример:</i> <code>✨ Бесплатный VPN, подпишись @free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  webpage: `🌐 <b>Шаг 3/5 — Ссылка поддержки</b>

Ссылка на канал или поддержку.

<i>Пример:</i> <code>https://t.me/free_vpn123456</code>

Отправь <code>none</code> чтобы пропустить.`,

  interval: `⏰ <b>Шаг 4/5 — Интервал обновления</b>

Через сколько часов приложение должно обновлять подписку?

<i>Пример:</i> <code>4</code>

Отправь <code>none</code> чтобы пропустить.`,

  expireDays: `⏳ <b>Шаг 5/5 — Срок действия</b>

Сколько дней должна действовать подписка? По истечении срока приложение покажет, что подписка истекла.

<i>Пример:</i> <code>30</code> — подписка на 30 дней

Отправь <code>0</code> или <code>none</code> для безлимитного срока (без ограничения).`,
};
