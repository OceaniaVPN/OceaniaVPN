export function getConfig(env) {
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    adminId: parseInt(env.ADMIN_ID || "0"),
    configRepoOwner: env.CONFIG_REPO_OWNER || "OceaniaVPN",
    configRepoName: env.CONFIG_REPO_NAME || "StekloVPN",
    configsFolder: env.CONFIGS_FOLDER || "configs",
    branch: env.BRANCH || "main",
    kv: env.BOT_STATE,
    // 🎨 Нужен для сборки ссылки на тематическую страницу подписки (/page —
    // см. index.js). Задай в переменных Worker'а (Settings → Variables):
    // WORKER_ORIGIN = https://твой-воркер.workers.dev (без слэша в конце).
    workerOrigin: (env.WORKER_ORIGIN || "").replace(/\/$/, ""),
  };
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
