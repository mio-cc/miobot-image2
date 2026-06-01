export type ReplyStrategy = 'forward' | 'at' | 'quote' | 'plain';
export type LegacyReplyFormat = Exclude<ReplyStrategy, 'plain'>;
export type RouteKind = 'ignored' | 'chat' | 'help' | 'image' | 'free-mode';
export type PackagePhase = 'P2-skeleton' | 'P3-config' | 'P4-infrastructure' | 'P5-llm-adapter' | 'P6-napcat-adapter' | 'P7-reply-strategy' | 'P8-image-module' | 'P9-free-mode' | 'P10-bot-router' | 'P11-web-panel' | 'P12-config-regression';
export type ConfigSourceFormat = 'bare-config' | 'export-wrapper-v1' | 'export-wrapper-v2' | 'unknown-wrapper' | 'invalid';
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


