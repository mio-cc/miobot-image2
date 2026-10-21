import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface JsonlActionCursorState {
  offset: number;
  ids: string[];
}

export interface JsonlActionBatch<T> {
  actions: T[];
  nextOffset: number;
  reset: boolean;
}

/** 读取面板动作消费者游标。兼容旧版只有 ids 的 done 文件。 */
export async function loadJsonlActionCursor(filePath: string): Promise<JsonlActionCursorState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as { ids?: unknown; offset?: unknown };
    const offset = Number(parsed?.offset);
    return {
      offset: Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0,
      ids: Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [],
    };
  } catch {
    return { offset: 0, ids: [] };
  }
}

/**
 * 旧版 done 文件没有 offset。用最后一条已处理 ID 反推安全起点，
 * 避免升级后把历史动作整个重放一遍。
 */
export async function reconcileJsonlActionOffset(actionFile: string, state: JsonlActionCursorState): Promise<JsonlActionCursorState> {
  if (state.offset > 0 || !state.ids.length) return state;
  const raw = await fs.readFile(actionFile).catch(() => Buffer.alloc(0));
  if (!raw.length) return state;
  const lines = raw.toString('utf8').split('\n');
  const ids = new Set(state.ids);
  let offset = 0;
  let position = 0;
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    position += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    try {
      const action = JSON.parse(line) as { id?: unknown };
      if (action?.id !== undefined && ids.has(String(action.id))) {
        offset = position;
        found = true;
      }
    } catch { /* ignored malformed historical line */ }
  }
  return found ? { ...state, offset } : state;
}

/**
 * 只消费完整行（以换行结尾），保留最后一行未写完的内容给下一次轮询。
 * 当动作文件被截断/替换时 reset，而不是直接跳过新内容。
 */
export async function readJsonlActionBatch<T>(actionFile: string, offset: number): Promise<JsonlActionBatch<T>> {
  const raw = await fs.readFile(actionFile).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  });
  let start = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
  let reset = false;
  if (start > raw.length) {
    start = 0;
    reset = true;
  }
  const chunk = raw.subarray(start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { actions: [], nextOffset: start, reset };
  const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
  const actions: T[] = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try { actions.push(JSON.parse(line) as T); } catch { /* skip malformed complete line */ }
  }
  return { actions, nextOffset: start + lastNewline + 1, reset };
}

export async function saveJsonlActionCursor(filePath: string, state: JsonlActionCursorState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify({ ids: state.ids.slice(-2000), offset: Math.max(0, Math.trunc(state.offset)) }, null, 2), 'utf8');
  await fs.rename(temp, filePath);
}