/**
 * 统一数据契约（2026-11-19）。
 *
 * 为什么需要一个统一结构：现在 report.render 吃模型拼的 HTML、novel.platform 返回
 * 格式化文本、xlsx 各写一套表头——同一份抓取结果要出图/出表/出文件就得重写三次。
 * 统一成 Dataset 之后，下游只认列定义 + 记录，图表/表格/文件都能直接复用。
 */

export type ColumnType = 'string' | 'number' | 'boolean' | 'date';

export interface DatasetColumn {
  name: string;
  type: ColumnType;
  label?: string;
  /** 缺值是否算失败（verify 用）。 */
  required?: boolean;
}

export interface Dataset {
  columns: DatasetColumn[];
  records: Array<Record<string, unknown>>;
  meta: {
    source: string;
    url?: string;
    capturedAt: string;
    recipeId?: string;
    recipeVersion?: number;
    recordCount: number;
  };
}

export function createDataset(input: {
  columns: DatasetColumn[];
  records: Array<Record<string, unknown>>;
  source: string;
  url?: string;
  recipeId?: string;
  recipeVersion?: number;
  now?: Date;
}): Dataset {
  const records = Array.isArray(input.records) ? input.records : [];
  return {
    columns: input.columns,
    records,
    meta: {
      source: input.source,
      ...(input.url ? { url: input.url } : {}),
      capturedAt: (input.now || new Date()).toISOString(),
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
      ...(input.recipeVersion !== undefined ? { recipeVersion: input.recipeVersion } : {}),
      recordCount: records.length,
    },
  };
}

/** 值 → 该列声明的类型；无法转换时返回 undefined（由 verify 判失败）。 */
export function coerceValue(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (type === 'number') {
    const num = Number(String(value).replace(/[,，\s]/g, ''));
    return Number.isFinite(num) ? num : undefined;
  }
  if (type === 'boolean') {
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', '是'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', '否'].includes(text)) return false;
    return undefined;
  }
  if (type === 'date') {
    const time = Date.parse(String(value));
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
  }
  return String(value);
}

/** 按列定义把原始行规范化。 */
export function normalizeRecords(
  rows: Array<Record<string, unknown>>,
  columns: DatasetColumn[],
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      const value = coerceValue(row[column.name], column.type);
      if (value !== undefined) out[column.name] = value;
    }
    return out;
  });
}