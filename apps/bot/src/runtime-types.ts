import type { ReplyPlan } from '../../../packages/orchestration/src/index.js';

/** 新执行层的最小意图标签；不再依赖已删除的旧 intent router 类型。 */
export type RuntimeIntentKind =
  | 'chat'
  | 'image.generate'
  | 'image.edit'
  | 'image.interrogate'
  | 'video.generate'
  | 'ignore'
  | string;

export interface RuntimeFeatureContext {
  chatType?: 'group' | 'private';
  groupId?: string | number;
  userId?: string | number;
  promptChars?: number;
}

export interface RuntimeDecision {
  kind: RuntimeIntentKind;
  source?: string;
  confidence?: number;
  reason?: string;
  params?: Record<string, unknown>;
  usedPlanner?: boolean;
}

export interface RuntimeInput {
  text: string;
  images?: string[];
  videos?: string[];
  hasReferencedImage?: boolean;
  hasReferencedVideo?: boolean;
  /**
   * 本轮要额外注入 system 段的「系统事实」（2026-11-19）。
   * 典型用途：用户带了图但系统没能把图送到模型手里时，明确告诉模型
   * 「不要描述图、不要声称看到了图」，而不是让模型自己猜或反复说"看不到图"。
   * 与 userText 分开，避免被当成用户原话写进会话历史。
   */
  systemNotices?: string[];
  chatType: 'group' | 'private';
  sessionId: string;
  context?: string;
  referenceText?: string;
  forwardText?: string;
  featureId?: string;
  forceSearch?: boolean;
  featureContext?: RuntimeFeatureContext;
}

export interface RuntimeExplicitParams {
  [key: string]: unknown;
  prompt: string;
  size?: string;
  width?: number;
  height?: number;
  count?: number;
  quality?: string;
  templateId?: string;
  tokens?: string[];
}

export interface RuntimeResult {
  kind: RuntimeIntentKind;
  decision: RuntimeDecision;
  text?: string;
  images?: string[];
  skipGallerySync?: boolean;
  videos?: string[];
  files?: Array<string | { file: string; name?: string }>;
  audio?: string[];
  replyPlan?: ReplyPlan;
  handled: boolean;
}

export interface RuntimeExplicitEngine {
  handleExplicit(kind: RuntimeIntentKind, input: RuntimeInput, params: RuntimeExplicitParams): Promise<RuntimeResult>;
}
