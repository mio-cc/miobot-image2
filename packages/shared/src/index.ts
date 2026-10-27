// voice 仅对 text 有意义：合成 TTS 后以语音消息发送（sendRecord），TTS 不可用自动回退文本。
// 语音是 record，不参与合并转发；音频/文件硬约束在发送层不变。
export type ReplyStrategy = 'forward' | 'at' | 'quote' | 'plain' | 'text-image' | 'voice';
export type LegacyReplyFormat = Exclude<ReplyStrategy, 'plain' | 'text-image' | 'voice'>;
export type RouteKind = 'ignored' | 'chat' | 'help' | 'image' | 'free-mode';
export type PackagePhase = 'P2-skeleton' | 'P3-config' | 'P4-infrastructure' | 'P5-llm-adapter' | 'P6-napcat-adapter' | 'P7-reply-strategy' | 'P8-image-module' | 'P10-bot-router' | 'P11-web-panel' | 'P12-config-regression' | 'P2-model' | 'P4-agent-runtime' | 'P4-storage' | 'P5-admin-service' | 'P6-canvas-service';
export type ConfigSourceFormat = 'bare-config' | 'export-wrapper-v1' | 'export-wrapper-v2' | 'export-wrapper-v3' | 'unknown-wrapper' | 'invalid';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PackageDescriptor {
  name: string;
  phase: PackagePhase;
}

export interface MigrationNotice {
  id: string;
  from: string;
  to: string;
  reason: string;
}

export interface SerializableError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  category: 'timeout' | 'network' | 'upstream' | 'validation' | 'unknown';
  retryable: boolean;
  stack?: string;
  cause?: SerializableError;
  details?: unknown;
}



export * from './features.js';
