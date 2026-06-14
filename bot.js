/** @format */

require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Queue system
let queue = [];
let isProcessing = false;

// Cooldown map
const userCooldown = new Map();

// =========================
// QUEUE PROCESSOR
// =========================
async function processQueue() {
	if (isProcessing) return;
	if (queue.length === 0) return;

	isProcessing = true;

	const { chatId, url, platform } = queue.shift();

	try {
		// cooldown mark
		userCooldown.set(chatId, Date.now());

		await bot.sendMessage(chatId, `⏳ Скачиваю видео с ${platform}...`);

		const fileName = `${platform}_${Date.now()}_${chatId}_${Math.random()
			.toString(36)
			.slice(2)}.mp4`;

		const cmd = `yt-dlp -f "bestvideo+bestaudio/best" -o "${fileName}" "${url}"`;

		exec(cmd, async err => {
			if (err) {
				console.error('YT-DLP error:', err);
				await bot.sendMessage(chatId, 'Ошибка скачивания ❌');

				isProcessing = false;
				processQueue();
				return;
			}

			try {
				await bot.sendVideo(chatId, fileName, {
					caption: 'Готово ✅',
				});
			} catch (e) {
				console.error('Send video error:', e);
			}

			try {
				fs.unlinkSync(fileName);
			} catch (e) {
				console.error('File delete error:', e);
			}

			isProcessing = false;
			processQueue();
		});
	} catch (e) {
		console.error('Queue error:', e);
		isProcessing = false;
		processQueue();
	}
}

// =========================
// BOT HANDLER
// =========================
bot.on('message', async msg => {
	const chatId = msg.chat.id;

	// Ignore non-text and commands
	if (!msg.text || msg.text.startsWith('/')) return;

	const url = msg.text.trim();

	// Cooldown check (30s)
	const now = Date.now();
	if (userCooldown.has(chatId)) {
		const lastTime = userCooldown.get(chatId);
		if (now - lastTime < 30000) {
			return bot.sendMessage(
				chatId,
				'Пожалуйста, подождите 30 секунд перед следующим запросом ⏳'
			);
		}
	}

	// Validate URL
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return bot.sendMessage(chatId, 'Это не ссылка ❌');
	}

	const host = parsed.hostname;

	let platform = 'unknown';

	if (host.includes('tiktok.com')) {
		platform = 'tiktok';
	} else if (host.includes('instagram.com')) {
		platform = 'instagram';
	} else if (host.includes('youtube.com') || host.includes('youtu.be')) {
		platform = 'youtube';
	} else {
		return bot.sendMessage(chatId, 'Поддерживаются только TikTok, Instagram и YouTube ❌');
	}

	console.log(`[${new Date().toISOString()}] ${chatId} -> ${url} (${platform})`);

	// Add to queue
	queue.push({ chatId, url, platform });

	// Start processing
	processQueue();
});
