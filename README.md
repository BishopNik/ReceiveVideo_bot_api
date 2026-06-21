<!-- @format -->

# ReceiveVideo Bot

Ласкаво просимо до мого проекту! Тут я опишу, як розпочати роботу з проектом та його основні функції.

## Встановлення

1. Клонуйте репозиторій на локальний комп'ютер:

git clone https://github.com/BishopNik/ReceiveVideo_bot_api.git

2. Перейдіть до директорії проекту:
   cd ReceiveVideo_bot_api

3. Встановіть залежності:
   npm install

## Запуск

Перед запуском установите `ffmpeg` и `yt-dlp`, создайте `.env` с переменной
`BOT_TOKEN`, затем выполните:

npm start

Локально бот использует polling. На Render добавьте переменные окружения:

- `BOT_TOKEN` — токен Telegram-бота;
- `WEBHOOK_URL` — публичный адрес сервиса без завершающего слеша, например
  `https://receivevideo-bot-api.onrender.com`;
- `API_SECRET` — случайный секрет для защищённого `POST /download`;
- `TELEGRAM_WEBHOOK_SECRET` — необязательный случайный секрет из латинских
  букв, цифр, `_` и `-`. Если его нет, приложение создаёт стабильный секрет
  из `BOT_TOKEN`.

При наличии `WEBHOOK_URL` Telegram отправляет сообщения на webhook. Входящий
HTTP-запрос будит бесплатный сервис Render после периода простоя.

## API

Поставить видео в очередь и после обработки отправить его в Telegram:

```bash
curl -X POST https://receivevideo-bot-api.onrender.com/download \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_SECRET' \
  -d '{"chatId":817787848,"url":"https://www.instagram.com/reel/EXAMPLE/"}'
```

Успешный запрос возвращает HTTP `202`. Пользователь или чат должны ранее
разрешить боту отправлять сообщения.

Bot ReceiveVideo Клікніть /start

## Основні функції

Це Бот для запуску гри.

## Контакт

Якщо вас цікавить додаткова інформація, будь ласка, напишіть лист на адресу a.nikanorov@gmail.com.
