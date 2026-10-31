import * as echarts from 'echarts';
import type { BrowserRenderService, CodeArtifact } from '../../../packages/browser-render/src/index.js';

type Row = Record<string, unknown>;

export interface ReportRenderDeps {
  browserRenderer?: BrowserRenderService;
  outputDir: string;
  uploadFile?: (localPath: string, name: string, mime: string) => Promise<string>;
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void };
}

export interface ReportRenderResult {
  images: string[];
  pages: number;
  rows: number;
  warnings: string[];
  pageHeights: number[];
}

interface NormalColumn { key: string; label: string; width?: number; align?: 'left' | 'right' | 'center'; weight?: number; wrap?: boolean; }
interface NormalizedSpec {
  title: string;
  subtitle: string;
  insight: string;
  source: string;
  theme: 'dark' | 'light';
  layout: string;
  width: number;
  rows: Row[];
  columns: NormalColumn[];
  blocks: any[];
  pageSize: number;
}

const MAX_PAGES = 8;
const MAX_PAGE_SIZE = 60;
const DEFAULT_PAGE_SIZE = 30;
const PAGE_WIDTH = 1080;
const CHART_WIDTH = 980;
const CHART_HEIGHT = 430;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function asNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[char] as string));
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(value);
}

function normalizeColumns(raw: unknown, rows: Row[]): NormalColumn[] {
  const source = Array.isArray(raw) ? raw : [];
  if (source.length) {
    return source.map((item) => {
      if (typeof item === 'string') return { key: item, label: item };
      const record = asRecord(item);
      const key = asString(record.key || record.field || record.name);
      return {
        key: key || 'value',
        label: asString(record.label || record.title || key || '值'),
        ...(Number(record.width) > 0 ? { width: Math.max(48, Math.min(360, Math.trunc(Number(record.width)))) } : {}),
        ...(record.align === 'right' || record.align === 'center' ? { align: record.align } : {}),
        ...(Number(record.weight) > 0 ? { weight: Math.max(0.2, Math.min(5, Number(record.weight))) } : {}),
        ...(record.wrap === true || (record.wrap !== false && !(Number(record.width) > 0)) ? { wrap: true } : {}),
      };
    });
  }
  const keys = Object.keys(rows[0] || {}).filter((key) => !['__proto__', 'constructor', 'prototype'].includes(key));
  return keys.slice(0, 12).map((key) => ({ key, label: key }));
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('[') && !text.startsWith('{'))) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function normalizeRows(value: unknown): Row[] {
  const parsed = parseMaybeJson(value);
  const source = Array.isArray(parsed) ? parsed : asRecord(parsed).items || asRecord(parsed).rows || asRecord(parsed).data;
  if (!Array.isArray(source)) return [];
  return source
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .slice(0, 5000) as Row[];
}

function normalizeSpec(input: unknown): NormalizedSpec {
  const wrapped = asRecord(parseMaybeJson(input));
  const raw = asRecord(parseMaybeJson(wrapped.spec || wrapped.report || wrapped));
  const parsedBlocks = parseMaybeJson(raw.blocks);
  const blocks = Array.isArray(parsedBlocks) ? [...parsedBlocks] : parsedBlocks && typeof parsedBlocks === 'object' ? [parsedBlocks] : [];
  // 模型可能把数据放在 data/items/records，或者只放在 table/chart block 里；
  // 不能只看 raw.rows，否则会出现 rows=0 的空报告。
  let rows = normalizeRows(raw.rows ?? raw.data ?? raw.items ?? raw.records ?? raw.dataset);
  if (!rows.length) {
    for (const block of blocks) {
      const record = asRecord(block);
      const blockKind = asString(record.kind || record.type).toLowerCase();
      if (blockKind === 'table') {
        rows = normalizeRows(record.rows ?? record.data ?? record.items);
        if (rows.length) break;
      }
      if (blockKind === 'chart') {
        const chart = asRecord(record.chart || record);
        rows = normalizeRows(chart.data ?? record.rows);
        if (rows.length) break;
      }
    }
  }
  const rawColumns = parseMaybeJson(raw.columns);
  if (!blocks.length && Array.isArray(raw.kpis)) blocks.push({ kind: 'kpi', items: raw.kpis });
  if (!blocks.length && raw.chart) blocks.push({ kind: 'chart', chart: raw.chart });
  const pageSize = Math.max(5, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(raw.pageSize || raw.rowsPerPage) || DEFAULT_PAGE_SIZE)));
  return {
    title: asString(raw.title || raw.name, '数据报告'),
    subtitle: asString(raw.subtitle || raw.description || ''),
    insight: asString(raw.insight || raw.summary || ''),
    source: asString(raw.source || raw.footer || ''),
    theme: raw.theme === 'dark' ? 'dark' : 'light',
    layout: asString(raw.layout || 'report').toLowerCase(),
    width: Math.max(720, Math.min(1600, Math.trunc(Number(raw.width) || PAGE_WIDTH))),
    rows,
    columns: normalizeColumns(rawColumns, rows),
    blocks,
    pageSize,
  };
}

function chartData(block: any, spec: NormalizedSpec): Row[] {
  const chart = asRecord(block.chart || block);
  const own = Array.isArray(block.data) ? block.data : Array.isArray(chart.data) ? chart.data : [];
  return (own.length ? own : spec.rows).filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)) as Row[];
}

function chartSvg(chart: Record<string, any>, rows: Row[], spec: NormalizedSpec): string {
  const type = asString(chart.type || chart.chartType || 'bar').toLowerCase();
  const xKey = asString(chart.x || chart.xKey || chart.category || chart.nameKey || spec.columns[0]?.key || Object.keys(rows[0] || {})[0]);
  const yKey = asString(chart.y || chart.yKey || chart.value || chart.valueKey || spec.columns.find((column) => column.key !== xKey)?.key || Object.keys(rows[0] || {})[1]);
  const seriesKey = asString(chart.series || chart.seriesKey || '');
  const topN = Math.max(1, Math.min(30, Math.trunc(Number(chart.topN) || (type === 'pie' || type === 'donut' ? 6 : 10))));
  const unit = asString(chart.unit || '');
  const isPie = type === 'pie' || type === 'donut';
  const isScatter = type === 'scatter';
  const isArea = type === 'area';
  const isLine = type === 'line' || isArea;
  const isHorizontal = type === 'horizontal-bar' || type === 'hbar' || type === 'ranking';
  let data = rows.map((row) => ({ ...row, __x: String(row[xKey] ?? ''), __y: asNumber(row[yKey]), __series: seriesKey ? String(row[seriesKey] ?? '') : '' }))
    .filter((row) => row.__x !== '' || isScatter);
  if (isPie) {
    data = data.sort((a, b) => b.__y - a.__y);
    if (data.length > topN) {
      const head = data.slice(0, topN);
      const other = data.slice(topN).reduce((sum, row) => sum + row.__y, 0);
      if (other > 0) head.push({ __x: '其他', __y: other, __series: '' } as any);
      data = head;
    }
  } else if (!isLine && !isScatter) {
    data = data.sort((a, b) => b.__y - a.__y).slice(0, topN);
  }
  const seriesNames = [...new Set(data.map((row) => row.__series).filter(Boolean))];
  const colors = spec.theme === 'light'
    ? ['#8a5a35', '#2f6f62', '#b7791f', '#7c3aed', '#b45309', '#0f766e', '#9d174d', '#4d7c0f']
    : ['#d6a56b', '#7fb7a5', '#e0b25c', '#c89ad9', '#d98b5f', '#70b7c6', '#d77b8b', '#9fbf73'];
  const textColor = spec.theme === 'light' ? '#334155' : '#cbd5e1';
  const mutedColor = spec.theme === 'light' ? '#64748b' : '#94a3b8';
  const gridColor = spec.theme === 'light' ? '#e2e8f0' : '#24344f';
  const common: Record<string, any> = {
    animation: false,
    backgroundColor: 'transparent',
    color: colors,
    textStyle: { color: textColor, fontFamily: '"Noto Sans CJK SC", "Noto Sans CJK", "Source Han Sans SC", "WenQuanYi Zen Hei", "Microsoft YaHei", "Noto Sans SC", Arial, sans-serif' },
    grid: { left: 26, right: 28, top: seriesNames.length > 1 ? 54 : 28, bottom: 54, containLabel: true },
    tooltip: { show: false },
  };
  if (isPie) {
    common.series = [{
      type: 'pie', radius: type === 'donut' ? ['44%', '70%'] : ['0%', '68%'], center: ['50%', '53%'],
      avoidLabelOverlap: true,
      label: { color: textColor, fontSize: 15, formatter: (params: any) => `${params.name}\n${params.percent}%${unit ? ` · ${unit}` : ''}` },
      labelLine: { lineStyle: { color: mutedColor } },
      data: data.map((row) => ({ name: row.__x, value: row.__y })),
    }];
  } else if (isScatter) {
    common.xAxis = { type: 'value', axisLabel: { color: mutedColor }, splitLine: { lineStyle: { color: gridColor } } };
    common.yAxis = { type: 'value', axisLabel: { color: mutedColor }, splitLine: { lineStyle: { color: gridColor } } };
    common.series = (seriesNames.length ? seriesNames : ['']).map((name) => ({
      name: name || yKey, type: 'scatter', symbolSize: 12,
      data: data.filter((row) => !name || row.__series === name).map((row) => [asNumber((row as Row)[xKey]), row.__y]),
    }));
  } else {
    const categories = [...new Set(data.map((row) => row.__x))];
    const categoryAxis = { type: 'category', data: categories, inverse: isHorizontal, axisLabel: { color: mutedColor, fontSize: 13, interval: 0, rotate: !isHorizontal && categories.length > 8 ? 28 : 0 }, axisLine: { lineStyle: { color: gridColor } } };
    const valueAxis = { type: 'value', axisLabel: { color: mutedColor }, splitLine: { lineStyle: { color: gridColor } } };
    if (isHorizontal) { common.xAxis = valueAxis; common.yAxis = categoryAxis; } else { common.xAxis = categoryAxis; common.yAxis = valueAxis; }
    const groups = seriesNames.length ? seriesNames : [''];
    common.series = groups.map((name, index) => {
      const groupRows = data.filter((row) => !name || row.__series === name);
      const byCategory = new Map(groupRows.map((row) => [row.__x, row.__y]));
      return {
        name: name || yKey,
        type: isLine ? 'line' : 'bar',
        barMaxWidth: 44,
        smooth: false,
        showSymbol: false,
        ...(isArea ? { areaStyle: { opacity: 0.16 } } : {}),
        itemStyle: { borderRadius: isLine ? 0 : [6, 6, 0, 0] },
        data: categories.map((category) => byCategory.get(category) ?? 0),
        ...(isHorizontal ? { barMaxWidth: 28 } : {}),
        ...(index > 0 ? {} : {}),
      };
    });
    if (seriesNames.length > 1) common.legend = { top: 8, right: 20, textStyle: { color: mutedColor } };
  }
  const instance = echarts.init(null as any, undefined, { renderer: 'svg', ssr: true, width: CHART_WIDTH, height: CHART_HEIGHT } as any);
  try {
    instance.setOption(common as any);
    return instance.renderToSVGString();
  } finally {
    instance.dispose();
  }
}

function renderKpi(block: any): string {
  const items = Array.isArray(block.items) ? block.items : [];
  if (!items.length) return '';
  return `<section class="block kpi-block"><div class="kpi-grid">${items.slice(0, 6).map((item: any) => {
    const record = asRecord(item);
    const delta = asString(record.delta);
    return `<div class="kpi"><div class="kpi-label">${escapeHtml(record.label || '')}</div><div class="kpi-value">${escapeHtml(record.value ?? '')}</div>${delta ? `<div class="kpi-delta ${delta.startsWith('-') ? 'down' : 'up'}">${escapeHtml(delta)}</div>` : ''}</div>`;
  }).join('')}</div></section>`;
}

function renderText(block: any): string {
  const text = asString(block.text || block.content || block.markdown);
  return text ? `<section class="block text-block"><p>${escapeHtml(text)}</p></section>` : '';
}

function renderChart(block: any, spec: NormalizedSpec): string {
  const chart = asRecord(block.chart || block);
  const unit = asString(chart.unit);
  const rows = chartData(block, spec);
  if (!rows.length) return '<section class="block notice">图表没有可用数据</section>';
  let svg = '';
  try { svg = chartSvg(chart, rows, spec); } catch (error) {
    return `<section class="block notice">图表生成失败：${escapeHtml((error as Error)?.message || error)}</section>`;
  }
  return `<section class="block chart-block"><div class="block-head"><div><div class="block-kicker">CHART</div><h2>${escapeHtml(block.title || chart.title || '数据图表')}</h2>${block.subtitle ? `<p>${escapeHtml(block.subtitle)}</p>` : ''}${unit ? `<p>单位：${escapeHtml(unit)}</p>` : ''}</div><span class="chart-type">${escapeHtml(asString(chart.type || 'bar').toUpperCase())}</span></div><div class="chart-canvas">${svg}</div></section>`;
}

function renderTable(block: any, spec: NormalizedSpec): string {
  const rows = (Array.isArray(block.rows) ? block.rows : spec.rows).filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)) as Row[];
  const columns = normalizeColumns(block.columns || spec.columns, rows);
  const offset = Math.max(0, Number(block.offset) || 0);
  const total = Math.max(rows.length + offset, Number(block.totalRows) || rows.length + offset);
  if (!rows.length) return '<section class="block notice">没有可展示的表格数据</section>';
  const available = PAGE_WIDTH - 88 - 44 - 4;
  const fixed = columns.reduce((sum, column) => sum + (column.width || 0), 0);
  const weighted = columns.filter((column) => !column.width);
  const weightTotal = weighted.reduce((sum, column) => sum + (column.weight || 1), 0) || 1;
  const remaining = Math.max(120, available - fixed);
  let widths = columns.map((column) => column.width || Math.max(80, Math.floor(remaining * (column.weight || 1) / weightTotal)));
  const widthSum = widths.reduce((sum, width) => sum + width, 0);
  if (widthSum > available) widths = widths.map((width) => Math.max(56, Math.floor(width * available / widthSum)));
  const cellHtml = (column: NormalColumn, value: unknown): string => {
    const text = formatCell(value);
    if (/(trend|change|涨跌|环比|趋势)/i.test(`${column.key} ${column.label}`) && /^[+-]/.test(String(value ?? ''))) {
      return `<span class="trend ${String(value).startsWith('-') ? 'down' : 'up'}">${text}</span>`;
    }
    return text;
  };
  return `<section class="block table-block"><div class="block-head"><div><div class="block-kicker">TABLE</div><h2>${escapeHtml(block.title || '完整数据')}</h2>${block.subtitle ? `<p>${escapeHtml(block.subtitle)}</p>` : ''}</div><span class="row-count">${offset + 1}-${offset + rows.length} / ${total}</span></div><div class="table-wrap"><table><colgroup>${widths.map((width) => `<col style="width:${width}px">`).join('')}</colgroup><thead><tr>${columns.map((column) => `<th style="text-align:${column.align || 'left'}">${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td style="text-align:${column.align || 'left'};white-space:${column.wrap ? 'normal' : 'nowrap'};overflow-wrap:${column.wrap ? 'anywhere' : 'normal'}">${cellHtml(column, row[column.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}

function buildPageHtml(spec: NormalizedSpec, page: { blocks: any[] }, pageNo: number, totalPages: number): string {
  const dark = spec.theme !== 'light';
  const bg = dark ? '#1b1a18' : '#f3f0e8';
  const card = dark ? '#26231f' : '#fffdf8';
  const text = dark ? '#f5f1e8' : '#20252b';
  const muted = dark ? '#b8aa98' : '#6b706f';
  const line = dark ? '#493f35' : '#d9d1c3';
  const accent = dark ? '#d6a56b' : '#8a5a35';
  const blocks = page.blocks.map((block) => {
    const kind = asString(block.kind || block.type).toLowerCase();
    if (kind === 'kpi') return renderKpi(block);
    if (kind === 'chart') return renderChart(block, spec);
    if (kind === 'table') return renderTable(block, spec);
    return renderText(block);
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${spec.width},initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;min-height:0;height:auto;overflow:visible;background:${bg};color:${text};font-family:"Noto Sans CJK SC","Noto Sans CJK","Source Han Sans SC","WenQuanYi Zen Hei","Microsoft YaHei","Noto Sans SC",Arial,sans-serif}body{padding:38px 44px 30px}.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:1px solid ${line};padding-bottom:22px;margin-bottom:20px}.eyebrow,.block-kicker{color:${accent};font-size:12px;letter-spacing:2px;font-weight:800}.hero h1{font-size:34px;line-height:1.2;margin:8px 0 7px;letter-spacing:-1px}.hero p{margin:0;color:${muted};font-size:14px;line-height:1.5}.page-badge{border:1px solid ${line};background:${card};color:${muted};border-radius:999px;padding:8px 13px;font-size:12px;white-space:nowrap}.block{background:${card};border:1px solid ${line};border-radius:16px;padding:20px 22px;margin:0 0 15px}.block-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}.block-head h2{font-size:20px;margin:5px 0 0}.block-head p{font-size:12px;color:${muted};margin:5px 0 0}.chart-type,.row-count{color:${muted};font-size:11px;border:1px solid ${line};border-radius:8px;padding:5px 8px;white-space:nowrap}.chart-canvas{width:100%;overflow:hidden}.chart-canvas svg{display:block;width:100%;height:auto}.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.kpi{background:${dark ? '#211e1a' : '#faf7f0'};border:1px solid ${line};border-radius:12px;padding:14px}.kpi-label{font-size:12px;color:${muted}}.kpi-value{font-size:26px;font-weight:800;margin-top:7px;font-variant-numeric:tabular-nums}.kpi-delta{font-size:12px;font-weight:700;margin-top:4px}.kpi-delta.up,.trend.up{color:#34d399}.kpi-delta.down,.trend.down{color:#fb7185}.trend{font-weight:700;font-variant-numeric:tabular-nums}.table-wrap{overflow:hidden;border:1px solid ${line};border-radius:10px}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:15px}th{background:${dark ? '#3a3028' : '#f1e8da'};color:${muted};font-size:11px;letter-spacing:.5px;text-align:left;padding:10px 12px;border-bottom:1px solid ${line}}td{padding:10px 12px;border-bottom:1px solid ${line};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${text}}tbody tr:nth-child(even){background:${dark ? '#211e1a' : '#faf7f1'}}tbody tr:last-child td{border-bottom:0}.insight{background:${dark ? '#3a3028' : '#f7efe2'};border-left:4px solid ${accent};color:${dark ? '#f0dfc7' : '#5c4533'};padding:13px 16px;border-radius:8px;font-size:15px;line-height:1.55;margin:0 0 16px}.text-block p{color:${text};font-size:15px;line-height:1.7;white-space:pre-wrap;margin:0}.notice{color:${muted};font-size:14px}.footer{display:flex;justify-content:space-between;gap:12px;color:${muted};font-size:11px;margin-top:6px;padding:0 2px}.footer .source{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:800px){.hero h1{font-size:28px}body{padding:24px 22px}.table-wrap{overflow-x:auto}}
</style></head><body><header class="hero"><div><div class="eyebrow">MIOBOT · DATA REPORT</div><h1>${escapeHtml(spec.title)}</h1>${spec.subtitle ? `<p>${escapeHtml(spec.subtitle)}</p>` : ''}</div><span class="page-badge">第 ${pageNo} / ${totalPages} 页</span></header>${spec.insight && pageNo === 1 ? `<div class="insight">${escapeHtml(spec.insight)}</div>` : ''}${blocks}<footer class="footer"><span class="source">${escapeHtml(spec.source || '数据来源：Miobot 报告渲染')}</span><span>Miobot · report.render</span></footer></body></html>`;
}

function buildPages(spec: NormalizedSpec): Array<{ blocks: any[] }> {
  const tables: any[] = [];
  const charts: any[] = [];
  const top: any[] = [];
  for (const rawBlock of spec.blocks) {
    const block = asRecord(rawBlock);
    const kind = asString(block.kind || block.type).toLowerCase();
    if (kind === 'table') tables.push(block);
    else if (kind === 'chart') charts.push(block);
    else top.push(block);
  }
  if (!spec.blocks.length && spec.rows.length) {
    const categoryKey = spec.columns[0]?.key || Object.keys(spec.rows[0] || {})[0];
    const valueKey = spec.columns.find((column) => column.align === 'right' || /heat|value|score|count|sales|金额|销量|热度|数值/i.test(column.key))?.key
      || spec.columns.find((column) => column.key !== categoryKey)?.key
      || Object.keys(spec.rows[0] || {})[1];
    if (spec.layout === 'ranking' || spec.layout === 'dashboard') {
      charts.push({ kind: 'chart', title: spec.layout === 'ranking' ? 'TOP 10' : '关键指标', chart: { type: 'horizontal-bar', x: categoryKey, y: valueKey, topN: 10 } });
    }
    if (spec.columns.length) tables.push({ kind: 'table', columns: spec.columns, rows: spec.rows });
  }
  const pages: Array<{ blocks: any[] }> = [];
  if (top.length || charts.length) {
    const first = [...top];
    if (charts.length) first.push(charts[0]);
    if (first.length) pages.push({ blocks: first });
    for (const chart of charts.slice(1)) pages.push({ blocks: [chart] });
  }
  for (const table of tables) {
    const rows = (Array.isArray(table.rows) ? table.rows : spec.rows).filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)) as Row[];
    const pageSize = Math.max(5, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(table.pageSize) || spec.pageSize)));
    if (!rows.length) { pages.push({ blocks: [{ ...table, rows: [] }] }); continue; }
    for (let offset = 0; offset < rows.length; offset += pageSize) {
      pages.push({ blocks: [{ ...table, rows: rows.slice(offset, offset + pageSize), offset, totalRows: rows.length }] });
    }
  }
  if (!pages.length) pages.push({ blocks: [{ kind: 'text', text: spec.subtitle || '没有可展示的数据' }] });
  if (pages.length > MAX_PAGES) throw new Error(`报告需要 ${pages.length} 页，超过当前上限 ${MAX_PAGES} 页；请减少条目、提高每页行数或只输出 TOP N`);
  return pages;
}

export async function renderReport(input: unknown, deps: ReportRenderDeps): Promise<ReportRenderResult> {
  if (!deps.browserRenderer) throw new Error('报告渲染不可用：未配置浏览器渲染器');
  const spec = normalizeSpec(input);
  const hasDataBlocks = spec.blocks.some((block) => {
    const kind = asString(asRecord(block).kind || asRecord(block).type).toLowerCase();
    return kind === 'chart' || kind === 'table';
  });
  if (!spec.rows.length && hasDataBlocks) {
    throw new Error('报告没有可用数据行：请把工具结果放进 spec.rows / spec.data；不要只传空表或空图表 spec');
  }
  const pages = buildPages(spec);
  const images: string[] = [];
  const warnings: string[] = [];
  const pageHeights: number[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const html = buildPageHtml(spec, pages[index], index + 1, pages.length);
    const artifact: CodeArtifact = { format: 'html', title: `${spec.title}${pages.length > 1 ? ` ${index + 1}/${pages.length}` : ''}`, width: spec.width, height: 1000, fullPage: true, html };
    const rendered = await deps.browserRenderer.renderCode(artifact, deps.outputDir);
    const name = `report-${Date.now()}-${index + 1}-${pages.length}.png`;
    const url = deps.uploadFile ? await deps.uploadFile(rendered.path, name, 'image/png') : `file://${rendered.path}`;
    images.push(url);
    pageHeights.push(rendered.height);
    if (rendered.height > 6000) warnings.push(`第 ${index + 1} 页高度 ${rendered.height}px，建议减小 pageSize 或拆分内容`);
    deps.logger?.info('报告页面渲染完成', { page: index + 1, pages: pages.length, width: rendered.width, height: rendered.height, bytes: rendered.size });
  }
  deps.logger?.info('结构化报告渲染完成', { pages: pages.length, rows: spec.rows.length, images: images.length });
  return { images, pages: pages.length, rows: spec.rows.length, warnings, pageHeights };
}