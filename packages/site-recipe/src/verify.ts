/**
 * 配方结构校验（2026-11-19）。
 *
 * 为什么必须有：抓取最坏的失败不是报错，而是**返回 0 条或半空字段却宣称成功**。
 * 模型据此产出空图表、空报告，用户看到"成功"但内容是空的——比崩溃更难查。
 */
import type { Dataset, DatasetColumn } from './dataset.js';

export interface VerifyResult {
  ok: boolean;
  recordCount: number;
  failures: string[];
  /** 样本（最多 3 条），便于人工/模型核对。 */
  sample: Array<Record<string, unknown>>;
}

export interface VerifyRules {
  minRecords?: number;
  requiredFieldsNonEmpty?: string[];
  uniqueBy?: string[];
}

export function verifyDataset(
  dataset: Dataset,
  rules: VerifyRules = {},
  columns: DatasetColumn[] = dataset.columns,
): VerifyResult {
  const failures: string[] = [];
  const records = Array.isArray(dataset.records) ? dataset.records : [];
  const recordCount = records.length;
  const minRecords = Math.max(0, Math.trunc(Number(rules.minRecords ?? 1)));

  if (recordCount < minRecords) {
    failures.push('记录数不足：' + recordCount + ' < ' + minRecords);
  }

  // 必填字段非空率：低于 50% 判失败（个别脏数据可以容忍，大面积缺失说明选择器/路径错了）
  for (const field of rules.requiredFieldsNonEmpty || []) {
    if (!records.length) { failures.push('必填字段 ' + field + ' 无记录可校验'); continue; }
    const filled = records.filter((row) => {
      const value = row[field];
      return value !== undefined && value !== null && String(value).trim() !== '';
    }).length;
    const rate = filled / records.length;
    if (rate < 0.5) {
      failures.push('必填字段 ' + field + ' 非空率 ' + Math.round(rate * 100) + '% (<50%)');
    }
  }

  // 唯一键：重复说明取值路径错了（例如把整个对象当 id）
  for (const key of rules.uniqueBy || []) {
    const values = records.map((row) => String(row[key] ?? '')).filter(Boolean);
    const unique = new Set(values);
    if (values.length && unique.size < values.length) {
      failures.push('唯一键 ' + key + ' 出现重复：' + values.length + ' 条里只有 ' + unique.size + ' 个不同值');
    }
  }

  // 列类型：声明了但整列都没有合法值的列，说明映射写错了
  for (const column of columns) {
    if (!column.required) continue;
    const present = records.filter((row) => row[column.name] !== undefined).length;
    if (records.length && present === 0) {
      failures.push('列 ' + column.name + ' 全部缺失');
    }
  }

  return {
    ok: failures.length === 0,
    recordCount,
    failures,
    sample: records.slice(0, 3),
  };
}