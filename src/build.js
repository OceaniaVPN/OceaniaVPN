export function buildFile(state, uris = [], defaults = {}) {
  const lines = [];
  const title = state.title || defaults.title || "My Subscription";
  const interval = state.interval || defaults.interval || 4;

  // ⏳ Ограничение по времени: state.expireDays приходит из шага 5/5 в /create
  // (см. state.js). "0"/"none"/пусто/отсутствует — подписка без ограничения
  // (expire=0, стандартная конвенция v2ray-клиентов). Иначе — реальный unix-
  // timestamp в СЕКУНДАХ (как того требует Subscription-Userinfo).
  const expireDaysRaw = state.expireDays;
  const expireDays = expireDaysRaw && expireDaysRaw !== "none" ? parseInt(expireDaysRaw, 10) : 0;
  const expireTs = expireDays > 0 ? Math.floor(Date.now() / 1000) + expireDays * 86400 : 0;

  lines.push(`#profile-title: ${title}`);
  lines.push(`#profile-update-interval: ${interval}`);
  lines.push(`#subscription-userinfo: upload=0; download=0; total=536870912000; expire=${expireTs}`);
  if (state.webpage) lines.push(`#profile-web-page-url: ${state.webpage}`);
  if (state.announce) lines.push(`#announce: ${state.announce}`);
  // Собственные служебные заголовки (не читаются VPN-клиентами, только нашей
  // страницей /page — см. index.js) — чтобы знать исходный срок для прогресс-бара.
  if (expireDays > 0) {
    lines.push(`#x-expire-days-total: ${expireDays}`);
    lines.push(`#x-expire-ts: ${expireTs}`);
  }
  // Выбранная пользователем тема страницы подписки (beach/forest/gori/ocean/pustinya/site).
  // Читается в index.js → pageSubscription вместо случайного выбора.
  if (state.theme) lines.push(`#x-theme: ${state.theme}`);
  lines.push("");
  if (uris.length > 0) lines.push(...uris);

  return lines.join("\n");
}
