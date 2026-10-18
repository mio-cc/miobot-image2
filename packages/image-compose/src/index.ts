import type { BotTextImageConfig, ComfyUiStitchConfig } from '../../config/src/index.js';

export interface ComposedImage { buffer: Buffer; mime: string; width: number; height: number }

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function loadSharp(): Promise<any> {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('图片处理需要安装 sharp');
  }
}

async function imageMetadata(sharp: any, buffer: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buffer).metadata();
  return { width: Math.max(1, Number(meta.width) || 1024), height: Math.max(1, Number(meta.height) || 1024) };
}

/** 多图本地拼接；默认按 1/2/2x2/3x2 规则布局，输出 JPEG quality 70。 */
export async function stitchImages(buffers: Buffer[], config: ComfyUiStitchConfig = {}): Promise<ComposedImage> {
  if (!buffers.length) throw new Error('没有可拼接的图片');
  const sharp = await loadSharp();
  if (buffers.length === 1) {
    const meta = await imageMetadata(sharp, buffers[0]);
    if (Number(config.scale || 1) !== 1) {
      const width = Math.max(1, Math.round(meta.width * Number(config.scale)));
      const height = Math.max(1, Math.round(meta.height * Number(config.scale)));
      const out = await sharp(buffers[0]).resize(width, height, { fit: 'inside' }).jpeg({ quality: clampInt(config.quality, 70, 1, 100), mozjpeg: true }).toBuffer();
      return { buffer: out, mime: 'image/jpeg', width, height };
    }
    return { buffer: buffers[0], mime: 'image/png', width: meta.width, height: meta.height };
  }

  const count = buffers.length;
  const defaultColumns = count === 2 ? 2 : count <= 4 ? 2 : 3;
  const columns = clampInt(config.columns, defaultColumns, 1, 8);
  const rows = Math.ceil(count / columns);
  const gap = clampInt(config.gap, 16, 0, 128);
  const maxWidth = clampInt(config.maxWidth, 4096, 128, 8192);
  const maxHeight = clampInt(config.maxHeight, 4096, 128, 8192);
  const first = await imageMetadata(sharp, buffers[0]);
  const aspect = first.height / first.width;
  let cellWidth = Math.floor((maxWidth - gap * (columns - 1)) / columns);
  let cellHeight = Math.max(1, Math.round(cellWidth * aspect));
  if (rows * cellHeight + gap * (rows - 1) > maxHeight) {
    cellHeight = Math.floor((maxHeight - gap * (rows - 1)) / rows);
    cellWidth = Math.max(1, Math.round(cellHeight / aspect));
  }
  const outputWidth = cellWidth * columns + gap * (columns - 1);
  const outputHeight = cellHeight * rows + gap * (rows - 1);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const resized = await sharp(buffers[i]).resize(cellWidth, cellHeight, { fit: 'cover', position: 'centre' }).png().toBuffer();
    composites.push({ input: resized, left: col * (cellWidth + gap), top: row * (cellHeight + gap) });
  }
  if (config.label !== false) {
    const labels = buffers.map((_, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = col * (cellWidth + gap) + 14;
      const y = row * (cellHeight + gap) + 28;
      return `<g><rect x="${x - 8}" y="${y - 20}" width="52" height="28" rx="8" fill="rgba(0,0,0,.55)"/><text x="${x}" y="${y}" fill="#fff" font-size="16" font-family="sans-serif">${i + 1}/${count}</text></g>`;
    }).join('');
    const overlay = Buffer.from(`<svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`);
    composites.push({ input: await sharp(overlay).png().toBuffer(), left: 0, top: 0 });
  }
  let output = sharp({ create: { width: outputWidth, height: outputHeight, channels: 3, background: config.background || '#111827' } })
    .composite(composites)
    .jpeg({ quality: clampInt(config.quality, 70, 1, 100), mozjpeg: true });
  let width = outputWidth;
  let height = outputHeight;
  const scale = Math.max(0.1, Math.min(2, Number(config.scale) || 1));
  if (scale !== 1) {
    width = Math.max(1, Math.round(outputWidth * scale));
    height = Math.max(1, Math.round(outputHeight * scale));
    output = output.resize(width, height, { fit: 'inside' });
  }
  const buffer = await output.toBuffer();
  return { buffer, mime: 'image/jpeg', width, height };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[char] as string));
}

function textWidth(line: string, fontSize: number): number {
  let width = 0;
  for (const char of line) width += /[\u2e80-\u9fff\uf900-\ufaff]/u.test(char) ? fontSize : fontSize * 0.56;
  return width;
}

function wrapLines(text: string, maxWidth: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    let line = '';
    for (const char of paragraph) {
      const next = line + char;
      if (line && textWidth(next, fontSize) > maxWidth) {
        out.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

/** 本地文本转图片；只依赖 sharp，不启动 Chromium。 */
export async function renderTextToImage(text: string, config: BotTextImageConfig): Promise<ComposedImage> {
  const sharp = await loadSharp();
  const width = clampInt(config.width, 1080, 320, 4096);
  const padding = clampInt(config.padding, 64, 8, 256);
  const fontSize = clampInt(config.fontSize, 32, 12, 96);
  const lineHeight = Math.max(1.1, Number(config.lineHeight) || 1.7) * fontSize;
  const maxLines = Math.max(1, Math.floor((config.maxHeight - padding * 2) / lineHeight));
  let lines = wrapLines(String(text || '').slice(0, config.maxChars), width - padding * 2, fontSize);
  let truncated = false;
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); truncated = true; }
  const height = Math.max(config.minHeight, Math.min(config.maxHeight, Math.ceil(lines.length * lineHeight + padding * 2)));
  const body = lines.map((line, i) => `<text x="${padding}" y="${padding + fontSize + i * lineHeight}" font-family="${escapeXml(config.fontFamily)}" font-size="${fontSize}" fill="${escapeXml(config.foreground)}">${escapeXml(line || ' ')}</text>`).join('');
  const footer = truncated ? `<text x="${padding}" y="${height - padding / 2}" font-family="${escapeXml(config.fontFamily)}" font-size="${Math.max(12, Math.round(fontSize * 0.55))}" fill="${escapeXml(config.accent)}">内容过长，已截断</text>` : '';
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="24" fill="${escapeXml(config.background)}"/><rect x="${padding}" y="${padding / 2}" width="${Math.max(24, width - padding * 2)}" height="4" rx="2" fill="${escapeXml(config.accent)}"/>${body}${footer}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: clampInt(config.quality, 70, 1, 100), mozjpeg: true }).toBuffer();
  return { buffer, mime: 'image/jpeg', width, height };
}
