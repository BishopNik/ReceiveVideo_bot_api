/** @format */

require('dotenv').config();
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { spawn, exec } = require('child_process');
const express = require('express');

const app = express();

app.get('/', (req, res) => {
	res.send('Bot is running');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
	console.log(`Web server listening on ${PORT}`);
});

const token = process.env.BOT_TOKEN;
if (!token) {
	console.error('ERROR: BOT_TOKEN is not defined in .env file!');
	process.exit(1);
}

// Настройка полинга с увеличенным таймаутом
const bot = new TelegramBot(token, {
	polling: {
		autoStart: true,
		params: { timeout: 30 },
	},
});
console.log('BOT_TOKEN успешно загружен.');

// Гасим системные ошибки полинга (AggregateError), чтобы не спамить консоль
bot.on('polling_error', error => {
	if (error.code === 'EFATAL' || error.message.includes('AggregateError')) {
		console.warn(
			`[${new Date().toLocaleTimeString()}] Сеть Telegram временно переподключается...`
		);
	} else {
		console.error('Ошибка полинга:', error);
	}
});

process.on('unhandledRejection', err => {
	console.error('Unhandled Rejection:', err);
});

process.on('uncaughtException', err => {
	console.error('Uncaught Exception:', err);
});

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
		userCooldown.set(chatId, Date.now());

		const statusMsg = await bot.sendMessage(chatId, `⏳ Начинаю обработку ${platform}... 0%`);

		const fileBase = `${platform}_${Date.now()}_${chatId}_${Math.random().toString(36).slice(2)}`;
		// Скачиваем в уникальный temp-файл, расширение yt-dlp определит сам
		const tempTemplate = `${process.cwd()}/${fileBase}_temp.%(ext)s`;
		const absolutePath = `${process.cwd()}/${fileBase}.mp4`;

		// Шаг 1: Просто скачиваем лучшее доступное видео (до 720p для экономии размера)
		const args = [
			url,
			'-f',
			'bestvideo+bestaudio/best',
			'--merge-output-format',
			'mkv',
			'--newline',
			'--no-part',
			'--progress',
			'-o',
			tempTemplate,
			'--force-overwrites',
		];

		const child = spawn('yt-dlp', args);

		child.stderr.on('data', data => {
			console.log('yt-dlp stderr:', data.toString());
		});

		child.stdout.on('data', data => {
			console.log('yt-dlp stdout:', data.toString());
		});

		let lastPercent = '';
		let lastUpdateTime = 0;

		const parseProgress = data => {
			const output = data.toString();
			const match = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);

			if (match) {
				const percent = Math.round(parseFloat(match[1])) + '%';
				const now = Date.now();

				if (percent !== lastPercent && now - lastUpdateTime > 2500) {
					lastPercent = percent;
					lastUpdateTime = now;

					bot.editMessageText(`⏳ Скачивание с ${platform}: ${percent}`, {
						chat_id: chatId,
						message_id: statusMsg.message_id,
					}).catch(() => {});
				}
			}
		};

		child.stdout.on('data', parseProgress);
		child.stderr.on('data', parseProgress);

		child.on('error', async err => {
			console.error('Spawn error:', err);
			await bot.sendMessage(chatId, 'Критическая ошибка запуска скачивания ❌');
			isProcessing = false;
			processQueue();
		});

		child.on('close', async code => {
			if (code !== 0) {
				console.error(`yt-dlp завершился с кодом ошибки: ${code}`);
				await bot.sendMessage(chatId, 'Ошибка скачивания файла ❌');
				isProcessing = false;
				processQueue();
				return;
			}

			// Находим скачанный yt-dlp файл (он может быть .mp4, .mkv, .webm)
			const files = fs.readdirSync(process.cwd());
			const downloadedFile = files.find(f => f.startsWith(`${fileBase}_temp.`));

			if (!downloadedFile) {
				await bot.sendMessage(chatId, 'Скачанный файл не найден ❌');
				isProcessing = false;
				processQueue();
				return;
			}

			const downloadedFilePath = `${process.cwd()}/${downloadedFile}`;

			// Обновляем статус на конвертацию
			await bot
				.editMessageText(`⚙️ Оптимизирую пропорции и кодеки...`, {
					chat_id: chatId,
					message_id: statusMsg.message_id,
				})
				.catch(() => {});

			// Шаг 2: Запускаем чистый ffmpeg обработчик.
			// Фильтр -vf указывает жестко использовать оригинальные пропорции (iw/ih), делая стороны четными.
			const convertCmd = `ffmpeg -y -i "${downloadedFilePath}" -c:v libx264 -profile:v high -level 4.0 -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p" -fps_mode cfr -c:a aac -b:a 128k -movflags +faststart "${absolutePath}"`;

			await new Promise(resolve => {
				exec(convertCmd, err => {
					if (err) console.error('Ошибка конвертации ffmpeg:', err);
					resolve();
				});
			});

			// Удаляем сырой скачанный файл после конвертации
			try {
				fs.unlinkSync(downloadedFilePath);
			} catch (e) {}

			// Проверяем результат конвертации
			if (!fs.existsSync(absolutePath)) {
				await bot.sendMessage(chatId, 'Ошибка обработки видео формата MP4 ❌');
				isProcessing = false;
				processQueue();
				return;
			}

			// Шаг 3: Проверяем вес файла на лимит Telegram (50 MB)
			const stats = fs.statSync(absolutePath);
			const fileSizeInMegabytes = stats.size / (1024 * 1024);
			console.log(`Финальный размер видео: ${fileSizeInMegabytes.toFixed(2)} MB`);

			// Автоматическое сжатие, если файл превышает лимит
			if (fileSizeInMegabytes >= 49.5) {
				await bot
					.editMessageText(
						`⚠️ Файл слишком большой (${fileSizeInMegabytes.toFixed(1)} MB). Сжимаю под лимиты Telegram...`,
						{
							chat_id: chatId,
							message_id: statusMsg.message_id,
						}
					)
					.catch(() => {});

				const compressedPath = `${process.cwd()}/${fileBase}_compressed.mp4`;
				const compressCmd = `ffmpeg -y -i "${absolutePath}" -c:v libx264 -crf 30 -preset faster -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p" -c:a aac -b:a 64k "${compressedPath}"`;

				await new Promise(resolve => {
					exec(compressCmd, cErr => {
						if (!cErr && fs.existsSync(compressedPath)) {
							try {
								fs.unlinkSync(absolutePath);
							} catch (e) {}
							fs.renameSync(compressedPath, absolutePath);
							console.log('Видео успешно сжато.');
						} else {
							console.error('Не удалось сжать видео:', cErr);
						}
						resolve();
					});
				});
			}

			// Шаг 4: Отправка готового файла
			await bot
				.editMessageText(`🎬 Видео подготовлено! Отправляю в чат...`, {
					chat_id: chatId,
					message_id: statusMsg.message_id,
				})
				.catch(() => {});

			try {
				const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${absolutePath}"`;

				const dimensions = await new Promise(resolve => {
					exec(probeCmd, (err, stdout) => {
						if (err || !stdout) return resolve({ width: undefined, height: undefined });
						const parts = stdout.trim().split('x');
						resolve({
							width: Number(parts[0]),
							height: Number(parts[1]),
						});
					});
				});

				await bot.sendVideo(chatId, absolutePath, {
					caption: 'Готово ✅ (оригинальное качество и пропорции сохранены)',
					width: dimensions.width,
					height: dimensions.height,
					supports_streaming: true,
				});
				await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
			} catch (e) {
				console.error('Send video error:', e.message);
				try {
					await bot.sendDocument(chatId, absolutePath, {
						caption: 'Готово (отправлено как файл) ✅',
					});
					await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
				} catch (docErr) {
					console.error('Send document error:', docErr.message);
					await bot.sendMessage(
						chatId,
						'Telegram отклонил отправку файла из-за превышения размера ❌'
					);
				}
			}

			// Полная очистка временных файлов сессии
			try {
				if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
			} catch (e) {}

			try {
				const remainingFiles = fs.readdirSync(process.cwd());
				const leftovers = remainingFiles.filter(f => f.includes(fileBase));
				for (const file of leftovers) {
					fs.unlinkSync(`${process.cwd()}/${file}`);
				}
			} catch (e) {}

			userCooldown.set(chatId, Date.now());
			isProcessing = false;
			processQueue();
		});
	} catch (e) {
		console.error('Queue critical error:', e);
		isProcessing = false;
		processQueue();
	}
}

// =========================
// BOT HANDLER
// =========================
bot.on('message', async msg => {
	const chatId = msg.chat.id;

	if (!msg.text || msg.text.startsWith('/')) return;

	const url = msg.text.trim();

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

	queue.push({ chatId, url, platform });
	processQueue();
});
