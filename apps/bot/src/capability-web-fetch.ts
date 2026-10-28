import { assertSafePublicUrl } from '../../../packages/browser-render/src/index.js';
import { fetchTextSafely } from './safe-http.js';

/**
 * R16/5.3：web.fetch——通用链接正文读取能力。
 * 静态 HTML → 剥 script/style 抽正文文本；动态页 → 降级建议模型改用截图；
 * B 站视频页 → 站点 adapter（公开 web 端点拿标题/UP/简介/分P/CC 字幕，纯 HTTP，1c2g 不拉视频流）。
 * SSRF 门：复用 browser-render 的 assertSafePublicUrl（协议白名单 + 私网拦截）。
 */

export interface WebFetchHandlerOptions {
  logger?: { warn: (message: string, data?: Record<string, unknown>) => void };
  allowPrivateHosts?: () => boolean;
  timeoutMs?: () => number;
  maxChars?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 12_000;

function htmlToText(value: string): string {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|aside|header|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

async function fetchText(url: URL, signal: AbortSignal | undefined, timeoutMs: number, allowPrivate: boolean, maxBytes: number): Promise<string> {
  const result = await fetchTextSafely(url.toString(), {
    assertSafeUrl: assertSafePublicUrl,
    allowPrivate,
    signal,
    timeoutMs,
    maxBytes,
    init: {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Miobot/2.0 (+web.fetch)',
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
  });
  if (!result.response.ok) throw new Error(`HTTP ${result.response.status}`);
  return result.text;
}

function extractBvid(url: URL): string {
  const path = url.pathname;
  const m = path.match(/\/video\/(bv[\w]+)/i) || path.match(/^\/(bv[\w]+)/i);
  return m ? m[1] : '';
}

async function fetchBilibiliInfo(bvid: string, signal?: AbortSignal): Promise<{ title: string; up: string; desc: string; duration: string; pages: number; stat: string } | null> {
  // bilibili-API-collect 公开端点：纯 HTTP 元数据；固定域名，但仍走受限读取。
  const api = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  try {
    const result = await fetchTextSafely(api, {
      assertSafeUrl: assertSafePublicUrl,
      allowPrivate: false,
      signal,
      timeoutMs: 10_000,
      maxBytes: 500_000,
      init: { headers: { 'user-agent': 'Mozilla/5.0 Miobot/2.0 (+web.fetch bilibili)', 'accept': 'application/json' } },
    });
    if (!result.response.ok) return null;
    const payload = JSON.parse(result.text) as any;
    if (payload?.code !== 0 || !payload?.data) return null;
    const d = payload.data;
    const stat = d.stat ? `播放${d.stat.view ?? '?'} 弹幕${d.stat.danmaku ?? '?'} 点赞${d.stat.like ?? '?'}` : '';
    return {
      title: String(d.title || ''),
      up: String(d.owner?.name || ''),
      desc: String(d.desc || '').slice(0, 2000),
      duration: String(d.duration ? `${Math.floor(Number(d.duration) / 60)}分${Number(d.duration) % 60}秒` : ''),
      pages: Number(d.pages?.length || 0),
      stat,
    };
  } catch {
    return null;
  }
}
export class WebFetchCapabilityHandler {
  constructor(private readonly options: WebFetchHandlerOptions = {}) {}

  async execute(args: Record<string, unknown>, context: { signal?: AbortSignal }): Promise<{ text: string }> {
    const rawUrl = String(args.url || '').trim();
    const configuredMax = this.options.maxChars?.() ?? DEFAULT_MAX_CHARS;
    const requestedMax = Number(args.maxChars);
    const maxChars = Math.max(500, Math.min(50_000, Math.trunc(Number.isFinite(requestedMax) ? requestedMax : configuredMax) || DEFAULT_MAX_CHARS));
    if (!rawUrl) throw new Error('web_fetch_missing_url');
    const allowPrivate = this.options.allowPrivateHosts?.() ?? false;
    const url = await assertSafePublicUrl(rawUrl, allowPrivate);

    // B 站视频页：站点 adapter 优先（元数据 + 简介文本化，不拉视频流）。
    const bvid = (url.hostname.endsWith('bilibili.com') || url.hostname.endsWith('b23.tv')) ? extractBvid(url) : '';
    if (url.hostname.endsWith('bilibili.com') && bvid) {
      const info = await fetchBilibiliInfo(bvid, context.signal);
      if (info) {
        const lines = [
          `标题：${info.title}`,
          `UP 主：${info.up}`,
          `时长：${info.duration}（${info.pages} 个分P）`,
          `数据：${info.stat}`,
          `简介：${info.desc}`,
          '',
          '提示：以上是视频的元数据与简介文本。如需查看页面视觉内容（弹幕/封面/评论区），请改用网页截图工具；字幕如需更多内容可继续追问。',
        ];
        return { text: lines.join('\n').slice(0, maxChars) };
      }
    }

    // 通用网页：抓 HTML → 剥脚本样式抽正文。
    const html = await fetchText(url, context.signal, this.options.timeoutMs?.() ?? DEFAULT_TIMEOUT_MS, allowPrivate, Math.min(2_000_000, Math.max(4000, maxChars * 8)));
    const title = extractTitle(html);
    const text = htmlToText(html);
    if (text.length < 200) {
      // 5.1/S-1 闭环：近空正文多为动态 SPA——返回结构化建议让模型自主换路，不静默失败。
      return {
        text: `页面「${title || rawUrl}」正文为空或过短（${text.length} 字符），大概率是需要脚本渲染的动态页面。\n建议：1) 改用网页截图工具查看视觉内容；2) 或用搜索工具检索该话题的关键信息。`,
      };
    }
    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n[内容截断：原文 ${text.length} 字符]` : text;
    return { text: `标题：${title}\n${truncated}` };
  }
}