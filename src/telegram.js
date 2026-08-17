async function tgRequest(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

export async function sendMessage(token, chatId, text, replyMarkup = null, parseMode = "HTML") {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgRequest(token, "sendMessage", body);
}

export async function editMessage(token, chatId, messageId, text, replyMarkup = null) {
  return tgRequest(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

export async function sendDocument(token, chatId, content, filename, caption = "") {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
  if (caption) form.append("caption", caption);
  return fetch(url, { method: "POST", body: form }).then((r) => r.json());
}

export async function answerCallback(token, callbackId) {
  return tgRequest(token, "answerCallbackQuery", { callback_query_id: callbackId });
}
