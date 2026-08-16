import os
import json
import base64
import io
from urllib.parse import quote
import requests
import telebot
from telebot import types

# === КОНФИГУРАЦИЯ ===
# Локально читаем из .env, в Workers - из окружения
def get_env(key, default=None):
    try:
        return os.environ[key]
    except KeyError:
        return default

TELEGRAM_BOT_TOKEN = get_env("TELEGRAM_BOT_TOKEN", "")
GITHUB_TOKEN = get_env("GITHUB_TOKEN", "")
REPO_OWNER = get_env("REPO_OWNER", "OceaniaVPN")
REPO_NAME = get_env("REPO_NAME", "OceaniaVPN")
CONFIGS_FOLDER = get_env("CONFIGS_FOLDER", "configs")  # Папка с конфигами
BRANCH = get_env("BRANCH", "main")
ADMIN_ID = int(get_env("ADMIN_ID", "0"))  # Telegram ID админа
WEBHOOK_URL = get_env("WEBHOOK_URL", "")  # URL твоего Cloudflare Worker

bot = telebot.TeleBot(TELEGRAM_BOT_TOKEN, threaded=False)

# === ФУНКЦИИ ДЛЯ РАБОТЫ С GITHUB API ===
def get_file_sha(filename):
    """Получает SHA хэш существующего файла (нужно для обновления)"""
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{CONFIGS_FOLDER}/{filename}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        return response.json().get("sha")
    return None

def create_or_update_github_file(filename, content, commit_message="Add VPN config"):
    """Создает или обновляет файл в папке configs"""
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{CONFIGS_FOLDER}/{filename}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    encoded_content = base64.b64encode(content.encode('utf-8')).decode('utf-8')
    
    data = {
        "message": commit_message,
        "content": encoded_content,
        "branch": BRANCH
    }
    
    # Если файл существует, добавляем SHA для обновления
    sha = get_file_sha(filename)
    if sha:
        data["sha"] = sha
    
    response = requests.put(url, headers=headers, json=data)
    return response.status_code, response.json()

def delete_github_file(filename, commit_message="Delete VPN config"):
    """Удаляет файл из папки configs"""
    sha = get_file_sha(filename)
    if not sha:
        return 404, {"message": "File not found"}
    
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{CONFIGS_FOLDER}/{filename}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    data = {
        "message": commit_message,
        "sha": sha,
        "branch": BRANCH
    }
    
    response = requests.delete(url, headers=headers, json=data)
    return response.status_code, response.json()

def get_github_files():
    """Получает список файлов из папки configs"""
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{CONFIGS_FOLDER}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        return response.json()
    return []

def get_github_file_content(filename):
    """Скачивает содержимое файла из папки configs"""
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{CONFIGS_FOLDER}/{filename}"
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        content_base64 = response.json()["content"]
        content_base64 = content_base64.replace("\n", "")
        return base64.b64decode(content_base64).decode('utf-8')
    return None

# === ОБРАБОТЧИКИ КОМАНД ===
@bot.message_handler(commands=['start'])
def start_message(message):
    keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
    keyboard.add(types.KeyboardButton("📋 Список конфигов"))
    keyboard.add(types.KeyboardButton("ℹ️ Помощь"))
    
    bot.send_message(
        message.chat.id,
        "👋 Добро пожаловать в **OceaniaVPN Bot**!\n\n"
        "Я храню VPN конфигурации и позволяю их скачивать.\n\n"
        "📱 **Команды:**\n"
        "/list - Список доступных конфигов\n"
        "/get <имя> - Скачать конфиг\n\n"
        "🛠 **Для админа:**\n"
        "/add <имя> <ссылка> - Добавить конфиг\n"
        "/delete <имя> - Удалить конфиг",
        parse_mode="Markdown",
        reply_markup=keyboard
    )

@bot.message_handler(commands=['add'])
def add_config(message):
    if message.chat.id != ADMIN_ID:
        bot.reply_to(message, "⛔️ У вас нет прав для добавления конфигов.")
        return
    
    try:
        parts = message.text.split(maxsplit=2)
        if len(parts) < 3:
            bot.reply_to(
                message,
                "❌ Неверный формат.\n\n"
                "**Пример:**\n"
                "`/add usa-wireguard.conf vless://12345@1.1.1.1:443?type=ws`",
                parse_mode="Markdown"
            )
            return
        
        filename = parts[1]
        content = parts[2]
        
        status, res = create_or_update_github_file(
            filename,
            content,
            f"Add VPN config: {filename}"
        )
        
        if status in [200, 201]:
            bot.reply_to(
                message,
                f"✅ Файл `{filename}` успешно сохранен в папке `{CONFIGS_FOLDER}/` на GitHub!",
                parse_mode="Markdown"
            )
        else:
            error_msg = res.get('message', 'Неизвестная ошибка')
            bot.reply_to(message, f"❌ Ошибка GitHub API: {error_msg}")
    
    except Exception as e:
        bot.reply_to(message, f"Произошла ошибка: {e}")

@bot.message_handler(commands=['delete'])
def delete_config(message):
    if message.chat.id != ADMIN_ID:
        bot.reply_to(message, "⛔️ У вас нет прав для удаления конфигов.")
        return
    
    try:
        parts = message.text.split(maxsplit=1)
        if len(parts) < 2:
            bot.reply_to(message, "❌ Укажи имя файла.\nПример: `/delete usa.conf`", parse_mode="Markdown")
            return
        
        filename = parts[1].strip()
        status, res = delete_github_file(filename, f"Delete VPN config: {filename}")
        
        if status == 200:
            bot.reply_to(message, f"🗑 Файл `{filename}` удален из `{CONFIGS_FOLDER}/`", parse_mode="Markdown")
        else:
            bot.reply_to(message, f"❌ Не удалось удалить файл: {res.get('message', 'неизвестная ошибка')}")
    
    except Exception as e:
        bot.reply_to(message, f"Ошибка: {e}")

@bot.message_handler(commands=['list'])
def list_configs(message):
    try:
        files_data = get_github_files()
        
        if not files_data or not isinstance(files_data, list):
            bot.reply_to(message, "📭 В папке `configs/` пока нет файлов.")
            return
        
        vpn_files = [f['name'] for f in files_data if f['type'] == 'file']
        
        if not vpn_files:
            bot.reply_to(message, "📭 Конфигов пока нет.")
            return
        
        response_text = f"📂 **Конфиги в папке `{CONFIGS_FOLDER}/`:**\n\n"
        for name in vpn_files:
            response_text += f"🔹 `{name}`\n"
        
        response_text += "\n💡 Чтобы скачать: `/get имя_файла`"
        bot.reply_to(message, response_text, parse_mode="Markdown")
    
    except Exception as e:
        bot.reply_to(message, f"Ошибка при получении списка: {e}")

@bot.message_handler(commands=['get'])
def get_config(message):
    try:
        parts = message.text.split(maxsplit=1)
        if len(parts) < 2:
            bot.reply_to(message, "❌ Укажи имя файла.\nПример: `/get usa.conf`", parse_mode="Markdown")
            return
        
        filename = parts[1].strip()
        content = get_github_file_content(filename)
        
        if content:
            if len(content) > 3000:
                file = io.BytesIO(content.encode('utf-8'))
                file.name = filename
                bot.send_document(message.chat.id, file, caption=f"🔗 Твой конфиг {filename}")
            else:
                bot.reply_to(
                    message,
                    f"🔗 **{filename}:**\n\n`{content}`",
                    parse_mode="Markdown"
                )
        else:
            bot.reply_to(message, f"❌ Файл `{filename}` не найден в папке `{CONFIGS_FOLDER}/`", parse_mode="Markdown")
    
    except Exception as e:
        bot.reply_to(message, f"Ошибка: {e}")

@bot.message_handler(func=lambda m: m.text == "📋 Список конфигов")
def handle_list_button(message):
    list_configs(message)

@bot.message_handler(func=lambda m: m.text == "ℹ️ Помощь")
def handle_help_button(message):
    start_message(message)

# === ЗАПУСК ===
def main():
    """Запуск для локального тестирования"""
    if WEBHOOK_URL:
        bot.remove_webhook()
        bot.set_webhook(url=WEBHOOK_URL)
        print(f"✅ Webhook установлен: {WEBHOOK_URL}")
    else:
        print("⚠️ Webhook не установлен, запуск в режиме polling...")
        print("Бот запущен и ожидает сообщений...")
        bot.infinity_polling()

# Для Cloudflare Workers (Python runtime)
try:
    async def on_fetch(request, env):
        """Обработчик запросов для Cloudflare Workers"""
        if request.method == "POST":
            # Telegram webhook
            try:
                update_data = await request.json()
                update = telebot.types.Update.de_json(update_data)
                bot.process_new_updates([update])
                return Response("OK", status=200)
            except Exception as e:
                return Response(f"Error: {str(e)}", status=500)
        
        return Response("OceaniaVPN Bot is running! 🚀", status=200)
except NameError:
    pass

if __name__ == "__main__":
    main()
