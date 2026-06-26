import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写文件：先写临时文件再 rename，避免"写到一半被读到"或"同步截断"导致的半截 JSON。
 * 这是整个 storage 层防数据损坏的基石。
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, resolved);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/** 读取并 JSON.parse；文件不存在或解析失败时返回 fallback（深拷贝，避免共享引用）。 */
export function readJsonSync<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    if (!raw.trim()) return clone(fallback);
    return JSON.parse(raw) as T;
  } catch {
    return clone(fallback);
  }
}

/** 原子写出 JSON（带 2 空格缩进，便于人读与 diff）。 */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(path.resolve(filePath));
  } catch {
    return false;
  }
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
