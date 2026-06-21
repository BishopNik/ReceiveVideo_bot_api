/** @format */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL?.replace(/\/$/, '');
const WEBHOOK_PATH = '/telegram/webhook';

const token = process.env.BOT_TOKEN;
if (!token) {
	console.error('ERROR: BOT_TOKEN is not defined in .env file!');
	process.exit(1);
}

const webhookSecret =
	process.env.TELEGRAM_WEBHOOK_SECRET ||
	crypto.createHash('sha256').update(token).digest('hex');
const bot = new TelegramBot(
	token,
	WEBHOOK_URL
		? {}
		: {
			polling: {
				autoStart: true,
				params: { timeout: 30 },
			},
		}
);
console.log('BOT_TOKEN успешно загружен.');

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

const queue = [];
let isProcessing = false;
const userCooldown = new Map();

const TELEGRAM_LIMIT_BYTES = 50 * 1024 * 1024;
const TARGET_FILE_BYTES = 47 * 1024 * 1024;

function runCommand(command, args, { onData } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderrTail = '';
		let settled = false;

		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			error ? reject(error) : resolve(result);
		};

		child.stdout.on('data', data => {
			onData?.(data);
		});
		child.stderr.on('data', data => {
			const output = data.toString();
			stderrTail = (stderrTail + output).slice(-12000);
			onData?.(data);
		});
		child.once('error', error => {
			finish(new Error(`Не удалось запустить ${command}: ${error.message}`));
		});
		child.once('close', code => {
			if (code === 0) return finish(null, { stderr: stderrTail });
			const details = stderrTail.trim().split('\n').slice(-8).join('\n');
			finish(new Error(`${command} завершился с кодом ${code}${details ? `:\n${details}` : ''}`));
		});
	});
}

function probeDuration(filePath) {
	return new Promise((resolve, reject) => {
		const child = spawn('ffprobe', [
			'-v',
			'error',
			'-show_entries',
			'format=duration',
			'-of',
			'default=noprint_wrappers=1:nokey=1',
			filePath,
		]);
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', data => (stdout += data));
		child.stderr.on('data', data => (stderr += data));
		child.once('error', reject);
		child.once('close', code => {
			const duration = Number.parseFloat(stdout);
			if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
				return reject(new Error(`ffprobe не смог определить длительность: ${stderr}`));
			}
			resolve(duration);
		});
	});
}

function probeDimensions(filePath) {
	return new Promise(resolve => {
		const child = spawn('ffprobe', [
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height',
			'-of',
			'csv=s=x:p=0',
			filePath,
		]);
		let stdout = '';

		child.stdout.on('data', data => (stdout += data));
		child.once('error', () => resolve({}));
		child.once('close', code => {
			if (code !== 0) return resolve({});
			const [width, height] = stdout.trim().split('x').map(Number);
			resolve(Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {});
		});
	});
}

async function compressToTelegramLimit(inputPath, outputPath, workDir) {
	const duration = await probeDuration(inputPath);
	const audioBitrate = 96_000;
	const totalBitrate = Math.floor((TARGET_FILE_BYTES * 8) / duration);
	const videoBitrate = totalBitrate - audioBitrate - 32_000;

	if (videoBitrate < 120_000) {
		throw new Error('Видео слишком длинное, чтобы уложить его в лимит Telegram');
	}

	const passlog = path.join(workDir, 'ffmpeg-pass');
	const commonArgs = [
		'-y',
		'-i',
		inputPath,
		'-c:v',
		'libx264',
		'-b:v',
		String(videoBitrate),
		'-vf',
		'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
		'-passlogfile',
		passlog,
	];

	await runCommand('ffmpeg', [
		...commonArgs,
		'-pass',
		'1',
		'-an',
		'-f',
		'null',
		os.devNull,
	]);
	await runCommand('ffmpeg', [
		...commonArgs,
		'-pass',
		'2',
		'-c:a',
		'aac',
		'-b:a',
		'96k',
		'-movflags',
		'+faststart',
		outputPath,
	]);
}

async function processJob({ chatId, url, platform }) {
	userCooldown.set(chatId, Date.now());
	let statusMsg;
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-video-'));

	try {
		statusMsg = await bot.sendMessage(chatId, `⏳ Начинаю обработку ${platform}... 0%`);
		const sourceTemplate = path.join(workDir, 'source.%(ext)s');
		const convertedPath = path.join(workDir, 'video.mp4');
		const compressedPath = path.join(workDir, 'video-compressed.mp4');
		let lastPercent = '';
		let lastUpdateTime = 0;

		const parseProgress = data => {
			const output = data.toString();
			const match = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
			if (!match) return;

			const percent = `${Math.round(Number.parseFloat(match[1]))}%`;
			const now = Date.now();
			if (percent === lastPercent || now - lastUpdateTime <= 2500) return;

			lastPercent = percent;
			lastUpdateTime = now;
			bot.editMessageText(`⏳ Скачивание с ${platform}: ${percent}`, {
				chat_id: chatId,
				message_id: statusMsg.message_id,
			}).catch(() => {});
		};

		await runCommand(
			'yt-dlp',
			[
				url,
				'-f',
				'bv*[height<=720]+ba/b[height<=720]/best',
				'--merge-output-format',
				'mkv',
				'--newline',
				'--no-part',
				'--progress',
				'--no-playlist',
				...(process.env.YT_DLP_JS_RUNTIME
					? ['--js-runtimes', process.env.YT_DLP_JS_RUNTIME]
					: []),
				'-o',
				sourceTemplate,
				'--force-overwrites',
			],
			{ onData: parseProgress }
		);

		const sourceFile = fs
			.readdirSync(workDir)
			.find(file => file.startsWith('source.') && !file.endsWith('.part'));
		if (!sourceFile) throw new Error('yt-dlp завершился, но скачанный файл не найден');

		await bot.editMessageText('⚙️ Оптимизирую пропорции и кодеки...', {
			chat_id: chatId,
			message_id: statusMsg.message_id,
		}).catch(() => {});

		await runCommand('ffmpeg', [
			'-y',
			'-i',
			path.join(workDir, sourceFile),
			'-c:v',
			'libx264',
			'-preset',
			'fast',
			'-crf',
			'23',
			'-profile:v',
			'high',
			'-level',
			'4.0',
			'-vf',
			'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
			'-fps_mode',
			'cfr',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-movflags',
			'+faststart',
			convertedPath,
		]);

		let finalPath = convertedPath;
		let fileSize = fs.statSync(finalPath).size;
		console.log(`Финальный размер видео: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

		if (fileSize >= TARGET_FILE_BYTES) {
			await bot.editMessageText(
				`⚠️ Файл весит ${(fileSize / 1024 / 1024).toFixed(1)} MB. Сжимаю под лимит Telegram...`,
				{ chat_id: chatId, message_id: statusMsg.message_id }
			).catch(() => {});
			await compressToTelegramLimit(convertedPath, compressedPath, workDir);
			finalPath = compressedPath;
			fileSize = fs.statSync(finalPath).size;
		}

		if (fileSize >= TELEGRAM_LIMIT_BYTES) {
			throw new Error(`После сжатия файл всё ещё слишком большой: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
		}

		await bot.editMessageText('🎬 Видео подготовлено! Отправляю в чат...', {
			chat_id: chatId,
			message_id: statusMsg.message_id,
		}).catch(() => {});

		const dimensions = await probeDimensions(finalPath);
		try {
			await bot.sendVideo(chatId, finalPath, {
				caption: 'Готово ✅ (оригинальные пропорции сохранены)',
				...dimensions,
				supports_streaming: true,
			});
		} catch (videoError) {
			console.error('Send video error:', videoError);
			await bot.sendDocument(chatId, finalPath, {
				caption: 'Готово (отправлено как файл) ✅',
			});
		}

		await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
	} catch (error) {
		console.error(`Ошибка обработки ${url}:`, error);
		const message = error.message.includes('слишком длинное')
			? 'Видео слишком длинное для лимита Telegram ❌'
			: 'Не удалось скачать или обработать видео ❌';
		if (statusMsg) {
			await bot.editMessageText(message, {
				chat_id: chatId,
				message_id: statusMsg.message_id,
			}).catch(() => bot.sendMessage(chatId, message).catch(() => {}));
		} else {
			await bot.sendMessage(chatId, message).catch(() => {});
		}
	} finally {
		try {
			fs.rmSync(workDir, { recursive: true, force: true });
		} catch (cleanupError) {
			console.error(`Не удалось очистить ${workDir}:`, cleanupError);
		}
		userCooldown.set(chatId, Date.now());
	}
}

async function processQueue() {
	if (isProcessing) return;
	isProcessing = true;

	try {
		while (queue.length > 0) {
			await processJob(queue.shift());
		}
	} finally {
		isProcessing = false;
		if (queue.length > 0) processQueue();
	}
}

function detectPlatform(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return { error: 'Это не ссылка' };
	}

	if (!['http:', 'https:'].includes(parsed.protocol)) {
		return { error: 'Поддерживаются только HTTP/HTTPS ссылки' };
	}

	const host = parsed.hostname.toLowerCase();
	if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
		return { platform: 'tiktok' };
	}
	if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
		return { platform: 'instagram' };
	}
	if (
		host === 'youtube.com' ||
		host.endsWith('.youtube.com') ||
		host === 'youtu.be'
	) {
		return { platform: 'youtube' };
	}
	return { error: 'Поддерживаются только TikTok, Instagram и YouTube' };
}

function enqueueDownload(chatId, url) {
	const now = Date.now();
	if (userCooldown.has(chatId) && now - userCooldown.get(chatId) < 30000) {
		return { ok: false, status: 429, error: 'Подождите 30 секунд перед следующим запросом' };
	}

	const detected = detectPlatform(url);
	if (detected.error) return { ok: false, status: 400, error: detected.error };

	userCooldown.set(chatId, now);
	queue.push({ chatId, url, platform: detected.platform });
	const position = queue.length;
	processQueue();
	return { ok: true, platform: detected.platform, position };
}

bot.on('message', async msg => {
	const chatId = msg.chat.id;
	if (!msg.text || msg.text.startsWith('/')) return;

	const url = msg.text.trim();
	const result = enqueueDownload(chatId, url);
	if (!result.ok) return bot.sendMessage(chatId, `${result.error} ❌`);

	console.log(`[${new Date().toISOString()}] ${chatId} -> ${url} (${result.platform})`);
});

function hasValidApiSecret(req) {
	const expected = process.env.API_SECRET;
	if (!expected) return false;
	const authorization = req.get('authorization') || '';
	const actual = authorization.startsWith('Bearer ')
		? authorization.slice(7)
		: req.get('x-api-key') || '';
	const expectedBuffer = Buffer.from(expected);
	const actualBuffer = Buffer.from(actual);
	return (
		expectedBuffer.length === actualBuffer.length &&
		crypto.timingSafeEqual(expectedBuffer, actualBuffer)
	);
}

app.get('/', (req, res) => {
	res.json({ status: 'ok', mode: WEBHOOK_URL ? 'webhook' : 'polling' });
});

app.post(WEBHOOK_PATH, (req, res) => {
	if (!WEBHOOK_URL) return res.sendStatus(404);
	if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret) {
		return res.sendStatus(401);
	}

	res.sendStatus(200);
	try {
		bot.processUpdate(req.body);
	} catch (error) {
		console.error('Ошибка Telegram webhook:', error);
	}
});

app.post('/download', (req, res) => {
	if (!process.env.API_SECRET) {
		return res.status(503).json({ error: 'API_SECRET не настроен' });
	}
	if (!hasValidApiSecret(req)) {
		return res.status(401).json({ error: 'Неверный API_SECRET' });
	}

	const { chatId, url } = req.body || {};
	if (!['string', 'number'].includes(typeof chatId) || typeof url !== 'string') {
		return res.status(400).json({ error: 'Нужны поля chatId и url' });
	}

	const result = enqueueDownload(chatId, url.trim());
	if (!result.ok) return res.status(result.status).json({ error: result.error });
	console.log(`[${new Date().toISOString()}] API ${chatId} -> ${url} (${result.platform})`);
	return res.status(202).json({
		status: 'queued',
		platform: result.platform,
		position: result.position,
	});
});

app.listen(PORT, '0.0.0.0', async () => {
	console.log(`Web server listening on ${PORT}`);
	if (!WEBHOOK_URL) {
		console.log('Telegram работает через polling (для локального запуска).');
		return;
	}

	try {
		const url = `${WEBHOOK_URL}${WEBHOOK_PATH}`;
		await bot.setWebHook(url, {
			secret_token: webhookSecret,
			allowed_updates: JSON.stringify(['message']),
		});
		console.log(`Telegram webhook установлен: ${url}`);
	} catch (error) {
		console.error('Не удалось установить Telegram webhook:', error);
	}
});
