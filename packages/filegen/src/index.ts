import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PptxGenJS: any = require('pptxgenjs');
const { ZipArchive }: any = require('archiver');
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, AlignmentType, TextRun, Header, Footer, PageNumber, PageBreak } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export const FILEGEN_PACKAGE = {
  name: '@miobot-v2/filegen',
  phase: 'P4-infrastructure' as const,
};

export type GeneratedFileType = 'txt' | 'md' | 'json' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'zip';

export type DocxTheme = 'business' | 'modern' | 'academic' | 'minimal' | 'report' | 'tech';
export type DocxTableStyle = 'grid' | 'striped' | 'minimal';

export interface GeneratedDocxTable {
  headers?: string[];
  rows?: Array<Array<string | number>>;
  caption?: string;
}

export interface GeneratedDocxCallout {
  title?: string;
  body?: string;
  tone?: 'info' | 'warn' | 'success';
}

export interface GeneratedFileSection {
  heading?: string;
  body?: string;
  bullets?: string[];
  table?: GeneratedDocxTable;
  callout?: GeneratedDocxCallout;
}

export interface GeneratedDocxStyle {
  theme?: DocxTheme;
  fontFamily?: string;
  accentColor?: string;
  textColor?: string;
  titleSize?: number;
  headingSize?: number;
  bodySize?: number;
  lineSpacing?: number;
  pageMargin?: number;
  coverPage?: boolean;
  header?: string;
  footer?: string;
  tableStyle?: DocxTableStyle;
}

export interface GeneratedFileSpec {
  type: GeneratedFileType;
  fileName?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  content?: string;
  style?: GeneratedDocxStyle;
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

const DOCX_THEMES: DocxTheme[] = ['business', 'modern', 'academic', 'minimal', 'report', 'tech'];
const DOCX_TABLE_STYLES: DocxTableStyle[] = ['grid', 'striped', 'minimal'];

function normalizeHexColor(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(raw) ? raw : fallback;
}

function normalizeDocxStyle(value: unknown): GeneratedDocxStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, any>;
  const theme = DOCX_THEMES.includes(raw.theme) ? raw.theme : 'business';
  const tableStyle = DOCX_TABLE_STYLES.includes(raw.tableStyle) ? raw.tableStyle : 'striped';
  const defaultAccent = theme === 'modern' ? '0F766E' : theme === 'report' ? '7C3AED' : theme === 'tech' ? '2563EB' : theme === 'academic' ? '333333' : theme === 'minimal' ? '111827' : '1F4E79';
  return {
    theme,
    fontFamily: clampString(raw.fontFamily || 'Microsoft YaHei', 120),
    accentColor: normalizeHexColor(raw.accentColor, defaultAccent),
    textColor: normalizeHexColor(raw.textColor, '1F2937'),
    titleSize: Math.max(18, Math.min(48, Number(raw.titleSize) || 30)),
    headingSize: Math.max(12, Math.min(28, Number(raw.headingSize) || 15)),
    bodySize: Math.max(9, Math.min(16, Number(raw.bodySize) || 11)),
    lineSpacing: Math.max(1, Math.min(2.2, Number(raw.lineSpacing) || 1.5)),
    pageMargin: Math.max(30, Math.min(100, Number(raw.pageMargin) || 50)),
    coverPage: raw.coverPage === undefined ? !['minimal', 'academic'].includes(theme) : raw.coverPage !== false,
    header: raw.header === undefined ? undefined : clampString(raw.header, 200),
    footer: raw.footer === undefined ? undefined : clampString(raw.footer, 200),
    tableStyle,
  };
}

function normalizeDocxTable(value: unknown): GeneratedDocxTable | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, any>;
  const rows = Array.isArray(raw.rows) ? raw.rows.slice(0, 100).map((row: any) => Array.isArray(row) ? row.slice(0, 20).map((cell: any) => typeof cell === 'number' ? cell : clampString(cell, 1000)) : []) : [];
  const headers = Array.isArray(raw.headers) ? raw.headers.slice(0, 20).map((cell: any) => clampString(cell, 500)) : [];
  if (!headers.length && !rows.length) return undefined;
  return { headers: headers.length ? headers : undefined, rows, caption: raw.caption === undefined ? undefined : clampString(raw.caption, 300) };
}

function normalizeDocxCallout(value: unknown): GeneratedDocxCallout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, any>;
  const tone = ['info', 'warn', 'success'].includes(raw.tone) ? raw.tone : 'info';
  if (!raw.title && !raw.body) return undefined;
  return { title: raw.title === undefined ? undefined : clampString(raw.title, 300), body: raw.body === undefined ? undefined : clampString(raw.body, 5000), tone };
}

export function normalizeGeneratedFileSpec(input: unknown, limits: FilegenLimits = DEFAULT_FILEGEN_LIMITS): GeneratedFileSpec {
  if (!input || typeof input !== 'object') throw new Error('文件生成参数必须是对象');
  const raw = input as Record<string, any>;
  const type = String(raw.type || '').toLowerCase() as GeneratedFileType;
  const allowed: GeneratedFileType[] = ['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf', 'zip'];
  if (!allowed.includes(type)) throw new Error(`不支持的文件类型: ${type || '空'}`);
  const spec: GeneratedFileSpec = { type, fileName: safeFileName(raw.fileName || raw.name || raw.title, type) };
  if (raw.title !== undefined) spec.title = clampString(raw.title, 500);
  if (raw.subtitle !== undefined) spec.subtitle = clampString(raw.subtitle, 500);
  if (raw.author !== undefined) spec.author = clampString(raw.author, 200);
  if (raw.date !== undefined) spec.date = clampString(raw.date, 100);
  if (raw.content !== undefined) spec.content = clampString(raw.content);
  spec.style = normalizeDocxStyle(raw.style);
  if (Array.isArray(raw.sections)) {
    spec.sections = raw.sections.slice(0, limits.maxSections).map((item: any) => ({
      heading: item?.heading === undefined ? undefined : clampString(item.heading, 500),
      body: item?.body === undefined ? undefined : clampString(item.body),
      bullets: Array.isArray(item?.bullets) ? item.bullets.slice(0, 200).map((bullet: any) => clampString(bullet, 2000)) : undefined,
      table: normalizeDocxTable(item?.table),
      callout: normalizeDocxCallout(item?.callout),
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

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function mixWithWhite(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (n: number) => Math.round(n + (255 - n) * amount).toString(16).padStart(2, '0').toUpperCase();
  return `${mix(r)}${mix(g)}${mix(b)}`;
}

const DOCX_FALLBACK_STYLE: Required<GeneratedDocxStyle> = {
  theme: 'business',
  fontFamily: 'Microsoft YaHei',
  accentColor: '1F4E79',
  textColor: '1F2937',
  titleSize: 30,
  headingSize: 15,
  bodySize: 11,
  lineSpacing: 1.5,
  pageMargin: 50,
  coverPage: true,
  header: '',
  footer: '',
  tableStyle: 'striped',
};

function docxStyle(spec: GeneratedFileSpec): Required<GeneratedDocxStyle> {
  return { ...DOCX_FALLBACK_STYLE, ...(spec.style || {}) } as Required<GeneratedDocxStyle>;
}

function sectionParagraphs(sections: GeneratedFileSection[] = [], style: Required<GeneratedDocxStyle>): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  const bodyRun = (text: string, bold = false, color = style.textColor) => new TextRun({ text, bold, color, font: style.fontFamily, size: style.bodySize * 2 });
  for (const section of sections) {
    if (section.heading) {
      out.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        keepNext: true,
        spacing: { before: 280, after: 120 },
        children: [new TextRun({ text: section.heading, bold: true, color: style.accentColor, font: style.fontFamily, size: style.headingSize * 2 })],
      }));
    }
    if (section.body) {
      for (const line of section.body.split(/\r?\n/)) {
        out.push(new Paragraph({
          spacing: { after: 100, line: Math.round(style.lineSpacing * 240) },
          children: [bodyRun(line)],
        }));
      }
    }
    for (const bullet of section.bullets || []) {
      out.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 70, line: Math.round(style.lineSpacing * 240) },
        children: [bodyRun(bullet)],
      }));
    }
    if (section.callout) {
      const tone = section.callout.tone || 'info';
      const fill = tone === 'warn' ? 'FEF3C7' : tone === 'success' ? 'DCFCE7' : 'E0F2FE';
      const toneColor = tone === 'warn' ? '92400E' : tone === 'success' ? '166534' : '075985';
      const calloutChildren: Paragraph[] = [];
      if (section.callout.title) calloutChildren.push(new Paragraph({ spacing: { after: 50 }, children: [new TextRun({ text: section.callout.title, bold: true, color: toneColor, font: style.fontFamily, size: style.bodySize * 2 })] }));
      if (section.callout.body) calloutChildren.push(new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: section.callout.body, color: style.textColor, font: style.fontFamily, size: style.bodySize * 2 })] }));
      if (calloutChildren.length) {
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: [new TableCell({
            shading: { fill, type: ShadingType.CLEAR },
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: calloutChildren,
          })] })],
        }));
        out.push(new Paragraph({ spacing: { after: 120 }, children: [bodyRun('')] }));
      }
    }
    if (section.table && (section.table.headers?.length || section.table.rows?.length)) {
      if (section.table.caption) out.push(new Paragraph({ spacing: { before: 100, after: 70 }, children: [new TextRun({ text: section.table.caption, italics: true, color: '6B7280', font: style.fontFamily, size: style.bodySize * 2 })] }));
      const rows: TableRow[] = [];
      const headers = section.table.headers || [];
      if (headers.length) {
        rows.push(new TableRow({
          tableHeader: true,
          children: headers.map((cell) => new TableCell({
            shading: { fill: style.accentColor, type: ShadingType.CLEAR },
            margins: { top: 90, bottom: 90, left: 120, right: 120 },
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(cell), bold: true, color: 'FFFFFF', font: style.fontFamily, size: style.bodySize * 2 })] })],
          })),
        }));
      }
      for (let i = 0; i < (section.table.rows || []).length; i += 1) {
        const row = section.table.rows![i];
        const fill = style.tableStyle === 'striped' && i % 2 === 1 ? mixWithWhite(style.accentColor, 0.92) : 'FFFFFF';
        rows.push(new TableRow({
          children: row.map((cell) => new TableCell({
            shading: style.tableStyle === 'minimal' ? undefined : { fill, type: ShadingType.CLEAR },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: String(cell), color: style.textColor, font: style.fontFamily, size: style.bodySize * 2 })] })],
          })),
        }));
      }
      out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      out.push(new Paragraph({ spacing: { after: 120 }, children: [bodyRun('')] }));
    }
  }
  return out;
}

async function generateDocx(spec: GeneratedFileSpec, outputPath: string): Promise<void> {
  const style = docxStyle(spec);
  const children: Array<Paragraph | Table> = [];
  const titleRun = new TextRun({ text: spec.title || '文档', bold: true, color: style.accentColor, font: style.fontFamily, size: style.titleSize * 2 });
  if (style.coverPage) {
    children.push(new Paragraph({ spacing: { before: 2400, after: 240 }, alignment: AlignmentType.CENTER, children: [titleRun] }));
    if (spec.subtitle) children.push(new Paragraph({ spacing: { after: 160 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.subtitle, color: '6B7280', font: style.fontFamily, size: style.bodySize * 2 + 4 })] }));
    if (spec.author) children.push(new Paragraph({ spacing: { after: 60 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.author, color: '6B7280', font: style.fontFamily, size: style.bodySize * 2 })] }));
    if (spec.date) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.date, color: '6B7280', font: style.fontFamily, size: style.bodySize * 2 })] }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  } else {
    children.push(new Paragraph({ spacing: { after: 80 }, children: [titleRun] }));
    if (spec.subtitle) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: spec.subtitle, color: '6B7280', font: style.fontFamily, size: style.bodySize * 2 + 2 })] }));
    children.push(new Paragraph({ spacing: { after: 180 }, border: { bottom: { color: style.accentColor, style: BorderStyle.SINGLE, size: 8, space: 8 } }, children: [new TextRun({ text: '', font: style.fontFamily, size: 2 })] }));
  }
  children.push(...sectionParagraphs(spec.sections, style));
  if (spec.content) {
    for (const line of spec.content.split(/\r?\n/)) children.push(new Paragraph({ spacing: { after: 100, line: Math.round(style.lineSpacing * 240) }, children: [new TextRun({ text: line, color: style.textColor, font: style.fontFamily, size: style.bodySize * 2 })] }));
  }
  if (!children.length) children.push(new Paragraph({ children: [new TextRun({ text: '', font: style.fontFamily })] }));

  const headerText = style.header || spec.title || '';
  const footerText = style.footer || '';
  const tiny = { color: '6B7280', font: style.fontFamily, size: 18 };
  const headers = headerText ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ ...tiny, text: headerText })] })] }) } : undefined;
  const footers = {
    default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ ...tiny, text: footerText ? `${footerText}  ` : '' }),
      new TextRun({ ...tiny, children: ['第 ', PageNumber.CURRENT, ' 页'] }),
    ] })] }),
  };
  const doc = new Document({
    styles: { default: { document: { run: { font: style.fontFamily, size: style.bodySize * 2, color: style.textColor }, paragraph: { spacing: { line: Math.round(style.lineSpacing * 240) } } } } },
    sections: [{
      properties: { page: { margin: { top: style.pageMargin * 20, right: style.pageMargin * 20, bottom: style.pageMargin * 20, left: style.pageMargin * 20 } } },
      headers,
      footers,
      children,
    }],
  });
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
