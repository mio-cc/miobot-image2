import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

export interface ScheduledJob {
  id: string;
  /** 每日 HH:MM（本地时区）。v1 支持 daily；后续可扩展 cron。 */
  kind: 'daily';
  hour: number;
  minute: number;
  type: string;
  enabled: boolean;
  /** 上次触发日期 YYYY-MM-DD（持久化，重启不重发）。 */
  lastRunDay?: string;
}

export interface SchedulerOptions {
  filePath: string;
  /** 触发时回调；返回的字符串即投递内容（由调用方决定发送通道）。 */
  run: (job: ScheduledJob) => Promise<string | null>;
  logger?: StructuredLogger;
  now?: () => Date;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * T3.1：轻量调度器——每日定时任务（首个租户：每日聚合日报）。
 * 任务持久化到 scheduled-jobs.json（原子写），30s 巡检；当日已触发不重发（重启安全）。
 * 设计为未来"定时提醒"复用：register() 动态加任务即可。
 */
export class SchedulerService {
  private jobs: ScheduledJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now || (() => new Date());
  }

  async start(): Promise<void> {
    await this.load();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 30_000);
    this.timer.unref?.();
    await this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  register(job: ScheduledJob): void {
    const existing = this.jobs.findIndex((item) => item.id === job.id);
    if (existing >= 0) this.jobs[existing] = { ...this.jobs[existing], ...job };
    else this.jobs.push(job);
    void this.save();
  }

  list(): ScheduledJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const today = dayKey(now);
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (job.lastRunDay === today) continue;
      if (minuteOfDay < job.hour * 60 + job.minute) continue;
      job.lastRunDay = today;
      try {
        const text = await this.options.run(job);
        this.options.logger?.info('调度任务触发', { id: job.id, type: job.type, delivered: Boolean(text) });
      } catch (error) {
        this.options.logger?.warn('调度任务失败', { id: job.id, type: job.type, error: String((error as Error)?.message || error) });
      }
      await this.save();
    }
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.filePath, 'utf8')) as { jobs?: unknown };
      if (Array.isArray(parsed?.jobs)) {
        this.jobs = parsed.jobs.filter((item): item is ScheduledJob =>
          Boolean(item && typeof item === 'object' && typeof (item as ScheduledJob).id === 'string' && typeof (item as ScheduledJob).type === 'string'));
      }
    } catch { /* 首次启动 */ }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
      const temp = this.options.filePath + '.tmp';
      await fs.writeFile(temp, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf8');
      await fs.rename(temp, this.options.filePath);
    } catch (error) {
      this.options.logger?.warn('调度任务保存失败', { error: String((error as Error)?.message || error) });
    }
  }
}

/**
 * 每日聚合日报（§11.5）：静默降级原则的观测闭环——一天一条，让静默可审计。
 * 数据全部来自既有文件（trace jsonl / 状态文件），确定性生成，不依赖模型。
 */
export async function buildDailyReport(input: {
  traceFile: string;
  dataDir: string;
  now?: () => Date;
}): Promise<string> {
  const now = input.now || (() => new Date());
  const today = dayKey(now());
  const yesterday = dayKey(new Date(now().getTime() - 24 * 60 * 60 * 1000));
  const stats = { requests: 0, plans: 0, fallbackLegacy: 0, preflightBlocked: 0, approval: 0, rateLimited: 0, summaryFallback: 0 };
  try {
    const raw = await fs.readFile(input.traceFile, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed) as { timestamp?: string; stage?: string; summary?: string };
        const day = String(item.timestamp || '').slice(0, 10);
        if (day !== today && day !== yesterday) continue;
        if (item.stage === 'request') stats.requests += 1;
        if (item.stage === 'plan') {
          stats.plans += 1;
          if (String(item.summary || '').includes('fallback_legacy')) stats.fallbackLegacy += 1;
        }
        if (item.stage === 'reply' && String(item.summary || '').includes('已拦截不回退旧链路')) stats.preflightBlocked += 1;
        if (item.stage === 'reply' && String(item.summary || '').includes('确定性任务摘要')) stats.summaryFallback += 1;
        if (item.stage === 'approval') stats.approval += 1;
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 无 trace 文件 */ }

  const counts: string[] = [];
  const countJson = async (file: string, label: string) => {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(input.dataDir, file), 'utf8')) as Record<string, unknown>;
      if (Array.isArray(parsed.jobs)) counts.push(`${label} ${parsed.jobs.length}`);
      else if (Array.isArray(parsed.records)) counts.push(`${label} ${parsed.records.length}`);
      else if (Array.isArray(parsed.artifacts)) counts.push(`${label} ${parsed.artifacts.length}`);
      else if (parsed.records && typeof parsed.records === 'object') counts.push(`${label} ${Object.keys(parsed.records).length}`);
    } catch { /* 无该文件 */ }
  };
  await countJson('pending-jobs.json', '待办任务');
  await countJson('suno-song-history.json', '歌曲历史');
  await countJson('managed-artifacts.json', '生成物索引');
  try {
    const sessions = JSON.parse(await fs.readFile(path.join(input.dataDir, 'sessions.json'), 'utf8')) as Record<string, unknown>;
    counts.push(`活跃会话 ${Object.keys(sessions).length}`);
  } catch { /* 无会话文件 */ }

  const lines = [
    `【Miobot 日报】${today}`,
    `近 24h 编排：请求 ${stats.requests}，规划 ${stats.plans}，回退旧链路 ${stats.fallbackLegacy}，前置拦截 ${stats.preflightBlocked}，审批 ${stats.approval}，零输出摘要兜底 ${stats.summaryFallback}`,
  ];
  if (counts.length) lines.push(`状态：${counts.join('，')}`);
  if (stats.requests === 0) lines.push('（近 24h 无编排请求记录）');
  return lines.join('\n');
}
