import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';

const require = createRequire(import.meta.url);

export const FILE_INGEST_PACKAGE = {
  name: '@miobot-v2/file-ingest',
  phase: 'P4-infrastructure' as const,
};

export type ParsedFileKind =
  | 'text'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'zip'
  | 'tar'
  | 'apk'
  | 'image'
  | 'audio'
  | 'video'
  | 'binary'
  | 'unsupported';

export interface FileParseLimits {
  maxBytes: number;
  maxTextChars: number;
  maxPdfPages: number;
  maxSpreadsheetRows: number;
  maxSlideCount: number;
  maxArchiveEntries: number;
  maxArchiveUncompressedBytes: number;
  maxArchiveTextEntries: number;
  maxApkEntries: number;
}

export interface ParsedFileResult {
  name: string;
  size: number;
  mime: string;
  kind: ParsedFileKind;
  text: string;
  truncated: boolean;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export const DEFAULT_FILE_PARSE_LIMITS: FileParseLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxTextChars: 100_000,
  maxPdfPages: 50,
  maxSpreadsheetRows: 200,
  maxSlideCount: 40,
  maxArchiveEntries: 500,
  maxArchiveUncompressedBytes: 50 * 1024 * 1024,
  maxArchiveTextEntries: 30,
  maxApkEntries: 500,
};

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.ini', '.conf', '.cfg',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.php', '.rb',
  '.sh', '.bash', '.ps1', '.sql', '.toml', '.env', '.properties', '.gradle', '.dockerfile',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.opus', '.flac', '.m4a', '.aac', '.silk']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.m4v']);

export function fileExtension(name: string): string {
  const base = path.basename(String(name || '')).toLowerCase();
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx) : '';
}

export function detectFileKind(name: string, mime = ''): ParsedFileKind {
  const ext = fileExtension(name);
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.zip') return 'zip';
  if (ext === '.tar' || ext === '.tgz' || ext === '.gz') return 'tar';
  if (ext === '.apk') return 'apk';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) return 'image';
  if (AUDIO_EXTENSIONS.has(ext) || mime.startsWith('audio/')) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) return 'video';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime.includes('presentationml')) return 'pptx';
  if (mime.includes('zip') || mime.includes('compressed')) return 'zip';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return 'text';
  return 'binary';
}

function decodeText(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
  let text = buffer.toString('utf8');
  const replacement = (text.match(/\uFFFD/g) || []).length;
  if (replacement > Math.max(2, text.length * 0.01)) {
    try { text = iconv.decode(buffer, 'gb18030'); } catch { /* keep utf8 */ }
  }
  return text.replace(/^\uFEFF/, '');
}

function trimText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n[内容已截断: 仅保留前 ${maxChars} 字符]`, truncated: true };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractXmlText(xml: string, tag: string, paragraphTag?: string): string {
  const source = paragraphTag ? xml.replace(new RegExp(`</${paragraphTag}>`, 'g'), '\n') : xml;
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const parts: string[] = [];
  for (const match of source.matchAll(re)) parts.push(unescapeXml(match[1]));
  return parts.join(paragraphTag ? '' : ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function textLikeEntry(name: string): boolean {
  const ext = fileExtension(name);
  return TEXT_EXTENSIONS.has(ext) || ['.csv', '.tsv', '.json', '.xml', '.html', '.md'].includes(ext);
}

function columnIndex(ref: string): number {
  const letters = String(ref || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  let out = 0;
  for (const ch of letters) out = out * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, out - 1);
}

function markdownTable(rows: string[][]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => String(row[i] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
  const header = normalized[0];
  const body = normalized.slice(1);
  return [header, header.map(() => '---'), ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function numberOrText(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) && String(n) === String(value).trim() ? String(n) : value;
}

async function parsePdf(buffer: Buffer, limits: FileParseLimits): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean }> {
  const warnings: string[] = [];
  const moduleName = 'pdfjs-dist/legacy/build/pdf.mjs';
  const pdfjs: any = await import(moduleName);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true }).promise;
  const pageCount = Math.min(Number(doc.numPages || 0), limits.maxPdfPages);
  const pages: string[] = [];
  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const text = (content.items || []).map((item: any) => String(item.str || '')).join(' ').trim();
    pages.push(`### 第 ${pageNo} 页\n${text}`);
  }
  if (Number(doc.numPages || 0) > pageCount) warnings.push(`PDF 共 ${doc.numPages} 页，仅解析前 ${pageCount} 页`);
  const trimmed = trimText(pages.join('\n\n'), limits.maxTextChars);
  return {
    text: trimmed.text,
    metadata: { pageCount: doc.numPages, parsedPages: pageCount },
    warnings,
    truncated: trimmed.truncated,
  };
}

function parseDocx(buffer: Buffer, limits: FileParseLimits): { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean } {
  const zip = new AdmZip(buffer);
  const documentXml = zip.readAsText('word/document.xml');
  const text = extractXmlText(documentXml, 'w:t', 'w:p');
  const trimmed = trimText(text, limits.maxTextChars);
  return { text: trimmed.text, metadata: { entries: zip.getEntries().length }, warnings: [], truncated: trimmed.truncated };
}

function parsePptx(buffer: Buffer, limits: FileParseLimits): { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean } {
  const zip = new AdmZip(buffer);
  const slides = zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0))
    .slice(0, limits.maxSlideCount);
  const parts = slides.map((name, index) => {
    const xml = zip.readAsText(name);
    return `### 第 ${index + 1} 页\n${extractXmlText(xml, 'a:t', 'a:p')}`;
  });
  const warnings = slides.length ? [] : ['PPTX 中没有找到幻灯片 XML'];
  const trimmed = trimText(parts.join('\n\n'), limits.maxTextChars);
  return { text: trimmed.text, metadata: { slideCount: slides.length }, warnings, truncated: trimmed.truncated };
}

function parseXlsx(buffer: Buffer, limits: FileParseLimits): { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean } {
  const zip = new AdmZip(buffer);
  const sharedXml = zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') || '';
  const sharedStrings: string[] = [];
  for (const match of sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const texts = Array.from(match[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((m) => unescapeXml(m[1]));
    sharedStrings.push(texts.join(''));
  }
  const workbookXml = zip.getEntry('xl/workbook.xml')?.getData().toString('utf8') || '';
  const sheetNames = Array.from(workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)).map((m) => unescapeXml(m[1]));
  const sheetEntries = zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] || 0) - Number(b.match(/sheet(\d+)/i)?.[1] || 0));
  const parts: string[] = [];
  const warnings: string[] = [];
  for (let s = 0; s < sheetEntries.length; s += 1) {
    const xml = zip.readAsText(sheetEntries[s]);
    const rows: string[][] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= limits.maxSpreadsheetRows) break;
      const row: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const inner = cellMatch[2];
        const ref = attrs.match(/\br="([A-Z]+\d+)"/i)?.[1] || '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
        const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] || inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] || '';
        let value = unescapeXml(raw);
        if (type === 's') value = sharedStrings[Number(value)] ?? '';
        else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
        else if (!type) value = numberOrText(value);
        row[columnIndex(ref)] = value;
      }
      if (row.some((v) => String(v || '').trim())) rows.push(row.map((v) => v ?? ''));
    }
    if (rows.length) {
      const title = sheetNames[s] || `Sheet${s + 1}`;
      parts.push(`### ${title}\n${markdownTable(rows)}`);
    }
  }
  if (sheetEntries.length > 0 && !parts.length) warnings.push('XLSX 没有解析到非空单元格');
  const trimmed = trimText(parts.join('\n\n'), limits.maxTextChars);
  return { text: trimmed.text, metadata: { sheets: sheetEntries.length, sharedStrings: sharedStrings.length }, warnings, truncated: trimmed.truncated };
}

function parseZip(buffer: Buffer, limits: FileParseLimits): { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean } {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const warnings: string[] = [];
  if (entries.length > limits.maxArchiveEntries) warnings.push(`压缩包条目 ${entries.length} 个，仅列出前 ${limits.maxArchiveEntries} 个`);
  const selected = entries.slice(0, limits.maxArchiveEntries);
  const lines = ['### 压缩包文件列表'];
  let totalUncompressed = 0;
  let textEntries = 0;
  const extracted: string[] = [];
  for (const entry of selected) {
    totalUncompressed += Number(entry.header.size || 0);
    lines.push(`- ${entry.entryName} (${entry.header.size || 0} bytes)`);
    if (textEntries >= limits.maxArchiveTextEntries) continue;
    if (!textLikeEntry(entry.entryName)) continue;
    if (totalUncompressed > limits.maxArchiveUncompressedBytes) {
      warnings.push('解压后体积超过限制，后续文本文件未读取');
      break;
    }
    if (Number(entry.header.size || 0) > 512 * 1024) continue;
    try {
      const text = decodeText(entry.getData()).slice(0, 20_000);
      extracted.push(`### ${entry.entryName}\n${text}`);
      textEntries += 1;
    } catch {
      warnings.push(`读取压缩包内 ${entry.entryName} 失败`);
    }
  }
  const trimmed = trimText([...lines, ...extracted].join('\n\n'), limits.maxTextChars);
  return {
    text: trimmed.text,
    metadata: { entries: entries.length, textEntries },
    warnings,
    truncated: trimmed.truncated,
  };
}

async function parseApk(filePath: string, buffer: Buffer, limits: FileParseLimits): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean }> {
  const warnings: string[] = [];
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory).slice(0, limits.maxApkEntries);
  let info: any = null;
  try {
    const AppInfoParser = require('app-info-parser');
    const parser = new AppInfoParser(filePath);
    info = await parser.parse();
  } catch (error) {
    warnings.push(`APK manifest 解析失败: ${String((error as Error)?.message || error)}`);
  }
  const manifest = info?.manifest || info || {};
  const packageName = manifest.package || manifest.packageName || manifest.package_name || '';
  const versionName = manifest.versionName || manifest.version_name || manifest.version || '';
  const versionCode = manifest.versionCode || manifest.version_code || '';
  const permissions = Array.isArray(manifest.usesPermissions)
    ? manifest.usesPermissions.map((item: any) => typeof item === 'string' ? item : String(item?.name || '')).filter(Boolean)
    : (Array.isArray(info?.permissions) ? info.permissions : []);
  const activities = Array.isArray(manifest.activities) ? manifest.activities.map((item: any) => typeof item === 'string' ? item : String(item?.name || '')).filter(Boolean) : [];
  const lines = [
    '# APK 基本信息',
    `- 文件: ${path.basename(filePath)}`,
    `- 大小: ${buffer.length} bytes`,
    `- 包名: ${packageName || '未知'}`,
    `- 版本: ${versionName || '未知'} (${versionCode || '未知'})`,
    `- 权限数: ${permissions.length}`,
    `- Activity 数: ${activities.length}`,
    `- ZIP 条目: ${zip.getEntries().length}`,
  ];
  if (permissions.length) lines.push('', '## 权限', ...permissions.slice(0, 100).map((name: string) => `- ${name}`));
  if (activities.length) lines.push('', '## Activity', ...activities.slice(0, 50).map((name: string) => `- ${name}`));
  const fileList = entries.slice(0, 100).map((entry) => `- ${entry.entryName} (${entry.header.size || 0} bytes)`);
  if (fileList.length) lines.push('', '## 文件列表', ...fileList);
  const trimmed = trimText(lines.join('\n'), limits.maxTextChars);
  return {
    text: trimmed.text,
    metadata: { packageName, versionName, versionCode, permissions: permissions.length, activities: activities.length, entries: zip.getEntries().length, raw: info ? { label: info.label, package: packageName, versionName, versionCode } : null },
    warnings,
    truncated: trimmed.truncated,
  };
}

function parseTar(): { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean } {
  return {
    text: '',
    metadata: {},
    warnings: ['TAR/GZ 解析暂未启用；请先上传 ZIP'],
    truncated: false,
  };
}

async function parseBinaryFallback(buffer: Buffer, limits: FileParseLimits): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean }> {
  const sample = buffer.slice(0, 4096);
  const nullCount = sample.filter((byte) => byte === 0).length;
  if (nullCount === 0) {
    const trimmed = trimText(decodeText(buffer), limits.maxTextChars);
    return { text: trimmed.text, metadata: { detected: 'text' }, warnings: ['扩展名未知，按纯文本读取'], truncated: trimmed.truncated };
  }
  return {
    text: '',
    metadata: { headHex: sample.slice(0, 32).toString('hex') },
    warnings: ['不支持的二进制格式；仅返回文件元数据'],
    truncated: false,
  };
}

export async function parseFile(
  filePath: string,
  options: { name?: string; mime?: string; limits?: Partial<FileParseLimits> } = {},
): Promise<ParsedFileResult> {
  const limits = { ...DEFAULT_FILE_PARSE_LIMITS, ...(options.limits || {}) };
  const name = options.name || path.basename(filePath);
  const mime = options.mime || '';
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('不是普通文件');
  if (stat.size > limits.maxBytes) throw new Error(`文件 ${name} 大小 ${stat.size} bytes，超过解析上限 ${limits.maxBytes} bytes`);
  const buffer = await fs.readFile(filePath);
  const kind = detectFileKind(name, mime);
  let result: { text: string; metadata: Record<string, unknown>; warnings: string[]; truncated: boolean };
  switch (kind) {
    case 'text': {
      const trimmed = trimText(decodeText(buffer), limits.maxTextChars);
      result = { text: trimmed.text, metadata: {}, warnings: [], truncated: trimmed.truncated };
      break;
    }
    case 'pdf': result = await parsePdf(buffer, limits); break;
    case 'docx': result = parseDocx(buffer, limits); break;
    case 'pptx': result = parsePptx(buffer, limits); break;
    case 'xlsx': result = parseXlsx(buffer, limits); break;
    case 'zip': result = parseZip(buffer, limits); break;
    case 'tar': result = parseTar(); break;
    case 'apk': result = await parseApk(filePath, buffer, limits); break;
    case 'image':
    case 'audio':
    case 'video':
      result = { text: '', metadata: { mediaType: kind }, warnings: [`${kind} 内容不在此处解析`], truncated: false };
      break;
    default: result = await parseBinaryFallback(buffer, limits); break;
  }
  return {
    name,
    size: stat.size,
    mime,
    kind,
    text: result.text,
    metadata: result.metadata,
    warnings: result.warnings,
    truncated: result.truncated,
  };
}

export function formatParsedFileForModel(result: ParsedFileResult): string {
  const header = [
    `[文件] ${result.name}`,
    `大小: ${result.size} bytes`,
    `类型: ${result.kind}${result.mime ? ` / ${result.mime}` : ''}`,
    `元数据: ${JSON.stringify(result.metadata).slice(0, 2000)}`,
  ];
  if (result.warnings.length) header.push(`警告: ${result.warnings.join('；')}`);
  if (!result.text.trim()) return header.join('\n');
  return `${header.join('\n')}\n\n${result.text}`;
}

export * from './pending-files.js';

