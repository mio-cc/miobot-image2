#!/usr/bin/env node
/**
 * Suno 单曲 mp3 下载验证脚本（匿名 rights 解密，不消耗 Suno 生成额度）。
 *
 * 用法：
 *   node scripts/suno-download-once.mjs <clipId 或 song 链接>
 *   MIOBOT_FFMPEG_PATH=/path/to/ffmpeg node scripts/suno-download-once.mjs <clipId>
 *
 * 落盘目录默认 .runtime/suno-audio；可用 --cache-dir 覆盖。
 * 只做「GET /api/clip → rights → 解密 → ffmpeg → mp3」一次真实下载，不调用任何生成类接口。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv[2];
if (!raw || raw.startsWith('--')) {
  console.error('用法：node scripts/suno-download-once.mjs <clipId 或 song 链接>');
  process.exit(1);
}
const cacheDirArgIndex = process.argv.indexOf('--cache-dir');
const cacheDir = cacheDirArgIndex > 0 && process.argv[cacheDirArgIndex + 1]
  ? path.resolve(process.argv[cacheDirArgIndex + 1])
  : path.join(ROOT, '.runtime', 'suno-audio');

const { downloadSunoClipMp3 } = await import('../dist/apps/bot/src/suno-downloader.js');

const started = Date.now();
try {
  const result = await downloadSunoClipMp3({ clipId: raw }, {
    cacheDir,
    logger: {
      info: (message, meta) => console.log('[info]', message, JSON.stringify(meta || {})),
      warn: (message, meta) => console.log('[warn]', message, JSON.stringify(meta || {})),
    },
  });
  const buffer = fs.readFileSync(result.filePath);
  const header = buffer.subarray(0, 4).toString('latin1');
  console.log(JSON.stringify({
    ...result,
    elapsedMs: Date.now() - started,
    header,
    playable: header.startsWith('ID3') || buffer[0] === 0xff,
  }, null, 2));
} catch (error) {
  console.error(`[failed] ${error.name} ${error.code || ''} ${error.message}`);
  process.exit(1);
}
