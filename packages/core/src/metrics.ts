import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * 轻量指标采集。
 *
 * 总览页需要「近 24 小时发生了什么」，但项目原来没有任何统计。
 * 这里按小时分桶记录几类事件，够画趋势图即可——不做通用监控系统。
 *
 * 落盘的原因：部署脚本用看门狗守着进程，改配置会重启，
 * 纯内存的话指标每次重启清零，趋势图基本没用。
 */

export type MetricEvent =
  | 'message'   // 路由处理的消息
  | 'command'   // 命中指令
  | 'chat'      // 对话回复
  | 'image'     // 生图成功
  | 'video'     // 视频生成成功
  | 'audio'     // 音乐/音频生成成功
  | 'voice'     // 语音发送成功
  | 'agent_failure'
  | 'agent_unavailable'  // P0-1：Agent off/shadow 下自然语言未处理（管理员通知计数） // Agent enforce 未产出可交付结果
  | 'error';    // 处理失败

export const METRIC_EVENTS: MetricEvent[] = ['message', 'command', 'chat', 'image', 'video', 'audio', 'voice', 'agent_failure', 'agent_unavailable', 'error'];

const BUCKET_COUNT = 24;
const HOUR_MS = 60 * 60 * 1000;

export interface MetricsBucket {
  /** 该桶代表的整点时间戳。 */
  hour: number;
  counts: Partial<Record<MetricEvent, number>>;
  /**
   * 维度计数（总览「按会话/按模型」面板）。
   * session key 约定：`group:{群号}` / `private:{QQ}`；model 为模型名。
   * 可选字段：旧 metrics.json 没有它，按空对象兼容读取，不回写历史。
   */
  dims?: { session?: Record<string, number>; model?: Record<string, number> };
}

/** record 的可选维度：会话与模型，缺省不计维度。 */
export interface MetricDims {
  session?: string;
  model?: string;
}

export interface MetricsSnapshot {
  hours: string[];
  hourLabels: string[];
  series: Record<string, number[]>;
  totals: Record<string, number>;
  /** 后 12 小时相对前 12 小时的变化百分比。 */
  trends: Record<string, number>;
  /** 各类操作的平均耗时（毫秒）。 */
  averages: Record<string, number>;
  /** 24h 窗口内按会话聚合的 Top 20（count 降序）；无维度数据时为空数组。 */
  sessionTop: Array<{ key: string; count: number }>;
  /** 24h 窗口内按模型聚合的全量计数（count 降序）。 */
  byModel: Array<{ key: string; count: number }>;
}

export interface MetricsState {
  buckets: MetricsBucket[];
  durations: Record<string, { total: number; count: number }>;
}

export interface MetricsStore {
  load(): MetricsState;
  save(state: MetricsState): void;
}

export interface MetricsOptions {
  store?: MetricsStore;
  /** 落盘防抖，默认 10 秒。 */
  flushDebounceMs?: number;
  now?: () => number;
}

function emptyState(): MetricsState {
  return { buckets: [], durations: {} };
}

/**
 * 指标收集器。没有注入 store 时纯内存运行（单测用）。
 */
export class Metrics {
  private state: MetricsState = emptyState();
  private readonly store?: MetricsStore;
  private readonly flushDebounceMs: number;
  private readonly now: () => number;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;

  constructor(options: MetricsOptions = {}) {
    this.store = options.store;
    this.flushDebounceMs = Math.max(0, Math.trunc(options.flushDebounceMs ?? 10_000));
    this.now = options.now || (() => Date.now());
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.store) return;
    try {
      const loaded = this.store.load();
      this.state = {
        buckets: Array.isArray(loaded?.buckets) ? loaded.buckets : [],
        durations: loaded?.durations && typeof loaded.durations === 'object' ? loaded.durations : {},
      };
      this.prune();
    } catch {
      // 指标文件损坏不该影响机器人运行，丢掉重来即可。
      this.state = emptyState();
    }
  }

  private currentHour(): number {
    return Math.floor(this.now() / HOUR_MS) * HOUR_MS;
  }

  private prune(): void {
    const cutoff = this.currentHour() - (BUCKET_COUNT - 1) * HOUR_MS;
    this.state.buckets = this.state.buckets.filter((b) => b.hour >= cutoff).slice(-BUCKET_COUNT);
  }

  private scheduleFlush(): void {
    if (!this.store || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushDebounceMs);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /**
   * 让下次访问重新从 store 读。
   *
   * 跨进程用：写在 bot 进程（消息流在那儿），读在 web 进程（面板在那儿）。
   * 读侧如果只在启动时 load 一次，面板永远看到的是进程启动那一刻的快照。
   * 没有 store 时这个调用是空操作，不会清掉内存里的数据。
   */
  reload(): void {
    if (!this.store) return;
    this.loaded = false;
  }

  flush(): void {
    if (!this.store) return;
    try {
      this.store.save(this.state);
    } catch {
      // 落盘失败不影响主流程。
    }
  }

  record(event: MetricEvent, count = 1, dims?: MetricDims): void {
    this.ensureLoaded();
    const hour = this.currentHour();
    let bucket = this.state.buckets.find((b) => b.hour === hour);
    if (!bucket) {
      bucket = { hour, counts: {} };
      this.state.buckets.push(bucket);
      this.prune();
    }
    bucket.counts[event] = (bucket.counts[event] || 0) + count;
    if (dims && (dims.session || dims.model)) {
      const d = (bucket.dims ||= {});
      if (dims.session) d.session = d.session || {}, d.session[dims.session] = (d.session[dims.session] || 0) + count;
      if (dims.model) d.model = d.model || {}, d.model[dims.model] = (d.model[dims.model] || 0) + count;
    }
    this.scheduleFlush();
  }

  /** 记录一次耗时（毫秒），用于总览页的平均耗时。 */
  recordDuration(key: string, ms: number): void {
    this.ensureLoaded();
    const entry = this.state.durations[key] || { total: 0, count: 0 };
    entry.total += Math.max(0, ms);
    entry.count += 1;
    this.state.durations[key] = entry;
    this.scheduleFlush();
  }

  /** 返回某类操作的历史平均耗时（毫秒）；没有样本时返回 undefined。 */
  durationAverage(key: string): number | undefined {
    this.ensureLoaded();
    const entry = this.state.durations[key];
    if (!entry || entry.count <= 0) return undefined;
    return Math.round(entry.total / entry.count);
  }

  /** 近 24 小时的分桶序列，缺失的小时补 0，方便前端直接画图。 */
  snapshot(): MetricsSnapshot {
    this.ensureLoaded();
    this.prune();

    const nowHour = this.currentHour();
    const hours: number[] = [];
    for (let i = BUCKET_COUNT - 1; i >= 0; i -= 1) hours.push(nowHour - i * HOUR_MS);

    const series: Record<string, number[]> = {};
    const totals: Record<string, number> = {};
    const trends: Record<string, number> = {};

    for (const event of METRIC_EVENTS) {
      const values = hours.map((hour) => this.state.buckets.find((b) => b.hour === hour)?.counts[event] || 0);
      series[event] = values;
      totals[event] = values.reduce((sum, v) => sum + v, 0);
      const recent = values.slice(12).reduce((a, b) => a + b, 0);
      const earlier = values.slice(0, 12).reduce((a, b) => a + b, 0);
      trends[event] = earlier === 0 ? (recent > 0 ? 100 : 0) : Math.round(((recent - earlier) / earlier) * 100);
    }

    const averages: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.state.durations)) {
      averages[key] = value.count ? Math.round(value.total / value.count) : 0;
    }

    // 维度聚合：只统计 24h 窗口内的桶（与 series 同一口径）。
    // 旧数据没有 dims 时聚合结果为空数组，前端按空态渲染。
    const windowHours = new Set(hours);
    const sessionCounts: Record<string, number> = {};
    const modelCounts: Record<string, number> = {};
    for (const bucket of this.state.buckets) {
      if (!windowHours.has(bucket.hour)) continue;
      for (const [key, value] of Object.entries(bucket.dims?.session || {})) {
        sessionCounts[key] = (sessionCounts[key] || 0) + value;
      }
      for (const [key, value] of Object.entries(bucket.dims?.model || {})) {
        modelCounts[key] = (modelCounts[key] || 0) + value;
      }
    }
    const toSorted = (source: Record<string, number>) =>
      Object.entries(source).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      hours: hours.map((h) => new Date(h).toISOString()),
      hourLabels: hours.map((h) => String(new Date(h).getHours()).padStart(2, '0')),
      series,
      totals,
      trends,
      averages,
      sessionTop: toSorted(sessionCounts).slice(0, 20),
      byModel: toSorted(modelCounts),
    };
  }

  reset(): void {
    this.state = emptyState();
    this.loaded = true;
    this.flush();
  }
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  return new Metrics(options);
}

/**
 * 文件型指标存储。bot 进程写、web 进程读，两边指到同一个文件。
 * 写用临时文件 + rename，避免读侧读到写了一半的 JSON。
 */
export function createFileMetricsStore(filePath: string): MetricsStore {
  return {
    load(): MetricsState {
      try {
        const raw = nodeFs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as MetricsState;
        return {
          buckets: Array.isArray(parsed?.buckets) ? parsed.buckets : [],
          durations: parsed?.durations && typeof parsed.durations === 'object' ? parsed.durations : {},
        };
      } catch {
        return { buckets: [], durations: {} };
      }
    },
    save(state: MetricsState): void {
      const tmp = `${filePath}.tmp`;
      nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      nodeFs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      nodeFs.renameSync(tmp, filePath);
    },
  };
}
