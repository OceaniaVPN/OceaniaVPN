export function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🚀 Создать подписку", callback_data: "create" }],
      [{ text: "📋 Моя подписка", callback_data: "my" }, { text: "📡 Серверы", callback_data: "list" }],
      [{ text: "🌐 Прокси", callback_data: "proxy" }, { text: "🔍 Декодер", callback_data: "decode" }],
      [{ text: "📤 Экспорт", callback_data: "export" }, { text: "⚡ Полезные функции", callback_data: "features" }],
      [{ text: "🧰 Инструменты", callback_data: "tools" }, { text: "ℹ️ Помощь", callback_data: "help" }]
    ]
  };
}

export function backToMenu() {
  return { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu" }]] };
}

export function subscriptionMenu() {
  return {
    inline_keyboard: [
      [{ text: "📋 Моя подписка", callback_data: "my" }],
      [{ text: "🎨 Страница подписки", callback_data: "theme_pick" }, { text: "📡 Серверы", callback_data: "list" }],
      [{ text: "➕ Добавить сервер", callback_data: "add_prompt" }],
      [{ text: "🗑 Удалить подписку", callback_data: "delete" }],
      [{ text: "🏠 Главное меню", callback_data: "menu" }]
    ]
  };
}
