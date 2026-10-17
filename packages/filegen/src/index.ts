import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PptxGenJS: any = require('pptxgenjs');
const { ZipArchive }: any = require('archiver');
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const FILEGEN_PACKAGE = {
  name: '@miobot-v2/filegen',
  phase: 'P4-infrastructure' as const,
};

export type GeneratedFileType = 'txt' | 'md' | 'json' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'zip';

export interface GeneratedFileSection {
  heading?: string;
  body?: string;
  bullets?: string[];
}

export interface GeneratedFileSpec {
  type: GeneratedFileType;
  fileName?: string;
  title?: string;
  content?: string;
  sections?: GeneratedFileSection[];
  sheets?: Array<{ name?: string; rows: Array<Array<string | number | null | undefined>> }>;
  slides?: Array<{ title?: string; bullets?: string[]; notes?: string }>;
  files?: Array<{ name: string; content: string }>;
}

export interface GeneratedFileResult {
  path: string;
  name: string;
  mime: string;
  size: number;
  type: GeneratedFileType;
}

export interface FilegenLimits {
  maxOutputBytes: number;
  maxSections: number;
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumnsPerSheet: number;
  maxSlides: number;
  maxZipEntries: number;
}

export const DEFAULT_FILEGEN_LIMITS: FilegenLimits = {
  maxOutputBytes: 20 * 1024 * 1024,
  maxSections: 200,
  maxSheets: 20,
  maxRowsPerSheet: 5000,
  maxColumnsPerSheet: 64,
  maxSlides: 60,
  maxZipEntries: 100,
};

const MIME_BY_TYPE: Record<GeneratedFileType, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

const DEFAULT_NAME: Record<GeneratedFileType, string> = {
  txt: 'document.txt', md: 'document.md', json: 'document.json', csv: 'document.csv',
  docx: 'document.docx', xlsx: 'document.xlsx', pptx: 'document.pptx', pdf: 'document.pdf', zip: 'bundle.zip',
};

function safeFileName(input: string | undefined, type: GeneratedFileType): string {
  const fallback = DEFAULT_NAME[type];
  const raw = path.basename(String(input || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return raw || fallback;
}

function ensureExtension(name: string, type: GeneratedFileType): string {
  const ext = `.${type}`;
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

function clampString(value: unknown, max = 200_000): string {
  return String(value ?? '').slice(0, max);
}

function normalizeRows(rows: unknown, limits: FilegenLimits): Array<Array<string | number | null | undefined>> {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limits.maxRowsPerSheet).map((row) => Array.isArray(row) ? row.slice(0, limits.maxColumnsPerSheet) : [String(row ?? '')]);
}

export function normalizeGeneratedFileSpec(input: unknown, limits: FilegenLimits = DEFAULT_FILEGEN_LIMITS): GeneratedFileSpec {
  if (!input || typeof input !== 'object') throw new Error('文件生成参数必须是对象');
  const raw = input as Record<string, any>;
  const type = String(raw.type || '').toLowerCase() as GeneratedFileType;
  const allowed: GeneratedFileType[] = ['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf', 'zip'];
  if (!allowed.includes(type)) throw new Error(`不支持的文件类型: ${type || '空'}`);
  const spec: GeneratedFileSpec = { type, fileName: safeFileName(raw.fileName || raw.name || raw.title, type) };
  if (raw.title !== undefined) spec.title = clampString(raw.title, 500);
  if (raw.content !== undefined) spec.content = clampString(raw.content);
  if (Array.isArray(raw.sections)) {
    spec.sections = raw.sections.slice(0, limits.maxSections).map((item: any) => ({
      heading: item?.heading === undefined ? undefined : clampString(item.heading, 500),
      body: item?.body === undefined ? undefined : clampString(item.body),
      bullets: Array.isArray(item?.bullets) ? item.bullets.slice(0, 200).map((bullet: any) => clampString(bullet, 2000)) : undefined,
    }));
  }
  if (Array.isArray(raw.sheets)) {
    spec.sheets = raw.sheets.slice(0, limits.maxSheets).map((item: any, index: number) => ({
      name: clampString(item?.name || `Sheet${index + 1}`, 80),
      rows: normalizeRows(item?.rows, limits),
    }));
  }
  if (Array.isArray(raw.slides)) {
    spec.slides = raw.slides.slice(0, limits.maxSlides).map((item: any) => ({
      title: item?.title === undefined ? undefined : clampString(item.title, 500),
      bullets: Array.isArray(item?.bullets) ? item.bullets.slice(0, 50).map((bullet: any) => clampString(bullet, 2000)) : [],
      notes: item?.notes === undefined ? undefined : clampString(item.notes, 5000),
    }));
  }
  if (Array.isArray(raw.files)) {
    spec.files = raw.files.slice(0, limits.maxZipEntries).map((item: any) => ({
      name: safeFileName(item?.name || 'file.txt', 'txt'),
      content: clampString(item?.content),
    }));
  }
  return spec;
}

function sectionParagraphs(sections: GeneratedFileSection[] = []): Paragraph[] {
  const out: Paragraph[] = [];
  for (const section of sections) {
    if (section.heading) out.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }));
    if (section.body) {
      for (const line of section.body.split(/\r?\n/)) out.push(new Paragraph({ text: line }));
    }
    for (const bullet of section.bullets || []) out.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
  }
  return out;
}

async function generateDocx(spec: GeneratedFileSpec, outputPath: string): Promise<void> {
  const children: Array<Paragraph | Table> = [];
  if (spec.title) children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE }));
  children.push(...sectionParagraphs(spec.sections));
  if (spec.content) children.push(...spec.content.split(/\r?\n/).map((line) => new Paragraph({ text: line })));
  const doc = new Document({ sections: [{ children }] });
  await fs.writeFile(outputPath, await Packer.toBuffer(doc));
}

async function generateXlsx(spec: GeneratedFileSpec, outputPath: string, limits: FilegenLimits): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheets = spec.sheets?.length ? spec.sheets : [{ name: 'Sheet1', rows: [['内容'], [spec.content || '']] }];
  for (let i = 0; i < sheets.length; i += 1) {
    const source = sheets[i];
    const sheet = workbook.addWorksheet(String(source.name || `Sheet${i + 1}`).slice(0, 31));
    for (const row of normalizeRows(source.rows, limits)) sheet.addRow(row as any[]);
    sheet.columns.forEach((column) => { column.width = 20; });
  }
  await workbook.xlsx.writeFile(outputPath);
}

async function generatePptx(spec: GeneratedFileSpec, outputPath: string, limits: FilegenLimits): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  if (spec.title) {
    const cover = pptx.addSlide();
    cover.addText(spec.title, { x: 0.8, y: 2.2, w: 11.7, h: 1.5, fontSize: 34, bold: true, align: 'center' });
  }
  const slides = spec.slides?.length ? spec.slides : [{ title: spec.title || '内容', bullets: (spec.content || '').split(/\r?\n/).filter(Boolean) }];
  for (const item of slides.slice(0, limits.maxSlides)) {
    const slide = pptx.addSlide();
    if (item.title) slide.addText(item.title, { x: 0.6, y: 0.45, w: 12.1, h: 0.8, fontSize: 24, bold: true });
    if (item.bullets?.length) slide.addText(item.bullets.map((line) => ({ text: line, options: { bullet: true } })), { x: 0.8, y: 1.5, w: 11.7, h: 5.3, fontSize: 16, breakLine: true });
    if (item.notes) slide.addNotes(item.notes);
  }
  await pptx.writeFile({ fileName: outputPath });
}

async function generatePdf(spec: GeneratedFileSpec, outputPath: string): Promise<void> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = createWriteStream(outputPath);
  doc.pipe(stream);
  if (spec.title) doc.fontSize(22).text(spec.title, { align: 'center' }).moveDown(1);
  for (const section of spec.sections || []) {
    if (section.heading) doc.fontSize(15).text(section.heading).moveDown(0.5);
    if (section.body) doc.fontSize(11).text(section.body).moveDown(0.5);
    for (const bullet of section.bullets || []) doc.fontSize(11).text(`• ${bullet}`);
  }
  if (spec.content) doc.fontSize(11).text(spec.content);
  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}

async function generateZip(spec: GeneratedFileSpec, outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of spec.files || []) archive.append(file.content, { name: file.name });
    void archive.finalize();
  });
}

export async function generateFile(
  spec: GeneratedFileSpec,
  outputDir: string,
  limits: FilegenLimits = DEFAULT_FILEGEN_LIMITS,
): Promise<GeneratedFileResult> {
  await fs.mkdir(outputDir, { recursive: true });
  const normalized = normalizeGeneratedFileSpec(spec, limits);
  const name = ensureExtension(safeFileName(normalized.fileName, normalized.type), normalized.type);
  const outputPath = path.join(outputDir, `${Date.now()}-${randomUUID()}-${name}`);
  switch (normalized.type) {
    case 'txt':
    case 'md':
    case 'json':
    case 'csv': {
      const content = normalized.content || (normalized.sections || []).map((section) => [
        section.heading ? `# ${section.heading}` : '',
        section.body || '',
        ...(section.bullets || []).map((bullet) => `- ${bullet}`),
      ].filter(Boolean).join('\n')).join('\n\n');
      await fs.writeFile(outputPath, content, 'utf8');
      break;
    }
    case 'docx': await generateDocx(normalized, outputPath); break;
    case 'xlsx': await generateXlsx(normalized, outputPath, limits); break;
    case 'pptx': await generatePptx(normalized, outputPath, limits); break;
    case 'pdf': await generatePdf(normalized, outputPath); break;
    case 'zip': await generateZip(normalized, outputPath); break;
    default: throw new Error(`不支持的文件类型: ${(normalized as any).type}`);
  }
  const stat = await fs.stat(outputPath);
  if (stat.size > limits.maxOutputBytes) {
    await fs.unlink(outputPath).catch(() => undefined);
    throw new Error(`生成文件 ${stat.size} bytes，超过上限 ${limits.maxOutputBytes} bytes`);
  }
  return { path: outputPath, name, mime: MIME_BY_TYPE[normalized.type], size: stat.size, type: normalized.type };
}

export function generatedFileSpecFromJson(text: string): GeneratedFileSpec {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || trimmed;
  const first = fenced.indexOf('{');
  const last = fenced.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('模型没有返回 JSON 文件结构');
  return normalizeGeneratedFileSpec(JSON.parse(fenced.slice(first, last + 1)));
}
