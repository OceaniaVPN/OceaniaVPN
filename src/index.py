import json
import base64

# === ИМПОРТЫ ИЗ JAVASCRIPT (встроены в Cloudflare Python Workers) ===
from js import fetch, Headers, FormData, Blob, Response

# === HTTP ЗАПРОСЫ ===
async def http_request(url, method="GET", headers=None, body=None):
    """Универсальный HTTP запрос через fetch"""
    options = {"method": method}
    
    if headers:
        options["headers"] = headers
    
    if body:
        if isinstance(body, dict):
            options["body"] = json.dumps(body)
        else:
            options["body"] = body
    
    response = await fetch(url, options)
    status = response.status
    
    try:
        text = await response.text()
        data = json.loads(text) if text else {}
    except:
        data = {}
    
    return status, data, response

# === КОНФИГУРАЦИЯ ===
def get_config(env):
    """Получает конфигурацию из переменных окружения"""
    def get_env(key, default=""):
        try:
            return getattr(env, key, default)
        except:
            return default
    
    return {
        "telegram_token": get_env("TELEGRAM_BOT_TOKEN"),
        "github_token": get_env("GITHUB_TOKEN"),
        "admin_id": int(get_env("ADMIN_ID", "0")),
        "repo_owner": get_env("REPO_OWNER", "OceaniaVPN"),
        "repo_name": get_env("REPO_NAME", "OceaniaVPN"),
        "configs_folder": get_env("CONFIGS_FOLDER", "configs"),
        "branch": get_env("BRANCH", "main")
    }

# === TELEGRAM API ===
async def send_telegram(token, method, params=None):
    """Отправляет запрос к Telegram Bot API"""
    url = f"https://api.telegram.org/bot{token}/{method}"
    headers_dict = {"Content-Type": "application/json"}
    headers_obj = Headers.new(headers_dict)
    
    status, data, _ = await http_request(url, "POST", headers_obj, params or {})
    return status, data

async def send_message(token, chat_id, text, parse_mode="Markdown"):
    """Отправляет текстовое сообщение"""
    return await send_telegram(token, "sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True
    })

async def send_document(token, chat_id, content, filename, caption=""):
    """Отправляет файл как документ"""
    form_data = FormData.new()
    blob = Blob.new([content], {"type": "text/plain;charset=utf-8"})
    
    form_data.append("chat_id", str(chat_id))
    form_data.append("document", blob, filename)
    if caption:
        form_data.append("caption", caption)
    
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    options = {"method": "POST", "body": form_data}
    response = await fetch(url, options)
    return await response.text()

# === GITHUB API ===
async def github_request(config, method, endpoint, body=None):
    """Запрос к GitHub API"""
    url = f"https://api.github.com/repos/{config['repo_owner']}/{config['repo_name']}{endpoint}"
    
    headers_dict = {
        "Authorization": f"token {config['github_token']}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "OceaniaVPN-Bot",
        "Content-Type": "application/json"
    }
    headers_obj = Headers.new(headers_dict)
    
    status, data, _ = await http_request(url, method, headers_obj, body)
    return status, data

async def get_file_sha(config, filename):
    """Получает SHA хэш файла"""
    status, data = await github_request(
        config, "GET",
        f"/contents/{config['configs_folder']}/{filename}?ref={config['branch']}"
    )
    if status == 200 and isinstance(data, dict):
        return data.get("sha")
    return None

async def create_or_update_file(config, filename, content, commit_message):
    """Создает или обновляет файл"""
    encoded_content = base64.b64encode(content.encode('utf-8')).decode('utf-8')
    
    body = {
        "message": commit_message,
        "content": encoded_content,
        "branch": config["branch"]
    }
    
    sha = await get_file_sha(config, filename)
    if sha:
        body["sha"] = sha
    
    return await github_request(
        config, "PUT",
        f"/contents/{config['configs_folder']}/{filename}",
        body
    )

async def delete_file(config, filename, commit_message):
    """Удаляет файл"""
    sha = await get_file_sha(config, filename)
    if not sha:
        return 404, {"message": "File not found"}
    
    body = {
        "message": commit_message,
        "sha": sha,
        "branch": config["branch"]
    }
    
    return await github_request(
        config, "DELETE",
        f"/contents/{config['configs_folder']}/{filename}",
        body
    )

async def list_files(config):
    """Список файлов в папке configs"""
    status, data = await github_request(
        config, "GET",
        f"/contents/{config['configs_folder']}?ref={config['branch']}"
    )
    if status == 200 and isinstance(data, list):
        return [f['name'] for f in data if f.get('type') == 'file']
    return []

async def get_file_content(config, filename):
    """Скачивает содержимое файла"""
    status, data = await github_request(
        config, "GET",
        f"/contents/{config['configs_folder']}/{filename}?ref={config['branch']}"
    )
    if status == 200 and isinstance(data, dict) and "content" in data:
        content_base64 = data["content"].replace("\n", "")
        try:
            return base64.b64decode(content_base64).decode('utf-8')
        except:
            return None
    return None

# === ОБРАБОТКА СООБЩЕНИЙ ===
async def handle_update(update, config):
    """Обрабатывает входящее сообщение от Telegram"""
    if "message" not in update:
        return
    
    message = update["message"]
    chat_id = message["chat"]["id"]
    user_id = message["from"]["id"]
    text = message.get("text", "")
    
    if not text or not text.startswith("/"):
        return
    
    parts = text.split()
    command = parts[0].split("@")[0].lower()
    
    # === /start ===
    if command == "/start":
        await send_message(
            config["telegram_token"],
            chat_id,
            "👋 Добро пожаловать в **OceaniaVPN Bot**!\n\n"
            "📱 **Команды:**\n"
            "/list — Список конфигов\n"
            "/get <имя> — Скачать\n\n"
            "🛠 **Для админа:**\n"
            "/add <имя> <ссылка> — Добавить\n"
            "/delete <имя> — Удалить"
        )
    
    # === /add ===
    elif command == "/add":
        if user_id != config["admin_id"]:
            await send_message(config["telegram_token"], chat_id, "⛔️ Нет прав.")
            return
        
        if len(parts) < 3:
            await send_message(
                config["telegram_token"],
                chat_id,
                "❌ Формат: `/add имя ссылка`\n**Пример:** `/add usa.conf vless://...`",
                parse_mode="Markdown"
            )
            return
        
        filename = parts[1]
        content = " ".join(parts[2:])
        
        status, data = await create_or_update_file(
            config, filename, content, f"Add VPN config: {filename}"
        )
        
        if status in [200, 201]:
            await send_message(
                config["telegram_token"],
                chat_id,
                f"✅ Файл `{filename}` сохранен в `{config['configs_folder']}/`",
                parse_mode="Markdown"
            )
        else:
            error = data.get('message', 'Ошибка')
            await send_message(config["telegram_token"], chat_id, f"❌ Ошибка: {error}")
    
    # === /delete ===
    elif command == "/delete":
        if user_id != config["admin_id"]:
            await send_message(config["telegram_token"], chat_id, "⛔️ Нет прав.")
            return
        
        if len(parts) < 2:
            await send_message(config["telegram_token"], chat_id, "❌ Укажи имя файла.")
            return
        
        filename = parts[1]
        status, data = await delete_file(config, filename, f"Delete: {filename}")
        
        if status == 200:
            await send_message(
                config["telegram_token"],
                chat_id,
                f"🗑 Файл `{filename}` удален.",
                parse_mode="Markdown"
            )
        else:
            await send_message(config["telegram_token"], chat_id, f"❌ Ошибка удаления.")
    
    # === /list ===
    elif command == "/list":
        files = await list_files(config)
        
        if not files:
            await send_message(config["telegram_token"], chat_id, "📭 Конфигов пока нет.")
            return
        
        response = f"📂 **Конфиги в `{config['configs_folder']}/`:**\n\n"
        for name in files:
            response += f"🔹 `{name}`\n"
        response += "\n💡 Чтобы скачать: `/get имя`"
        
        await send_message(config["telegram_token"], chat_id, response)
    
    # === /get ===
    elif command == "/get":
        if len(parts) < 2:
            await send_message(config["telegram_token"], chat_id, "❌ Укажи имя файла.")
            return
        
        filename = parts[1]
        content = await get_file_content(config, filename)
        
        if content:
            if len(content) > 3000:
                await send_document(
                    config["telegram_token"],
                    chat_id,
                    content,
                    filename,
                    caption=f"🔗 Конфиг {filename}"
                )
            else:
                await send_message(
                    config["telegram_token"],
                    chat_id,
                    f"🔗 **{filename}:**\n\n`{content}`",
                    parse_mode="Markdown"
                )
        else:
            await send_message(
                config["telegram_token"],
                chat_id,
                f"❌ Файл `{filename}` не найден.",
                parse_mode="Markdown"
            )

# === ГЛАВНЫЙ ОБРАБОТЧИК (entry point для Cloudflare) ===
async def on_fetch(request, env):
    """Главная функция, вызываемая Cloudflare Workers"""
    try:
        if request.method == "POST":
            update = await request.json()
            config = get_config(env)
            await handle_update(update, config)
            return Response.new("OK", status=200)
        
        # GET запрос - показываем что бот работает
        html = "<h1>🚀 OceaniaVPN Bot Active</h1><p>Bot is running on Cloudflare Workers.</p>"
        headers = Headers.new({"Content-Type": "text/html"})
        return Response.new(html, status=200, headers=headers)
    
    except Exception as e:
        return Response.new(f"Error: {str(e)}", status=500)
