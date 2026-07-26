import type { BotEngineDeps } from '../../../packages/bot-engine/src/index.js';
import type { ImageArtifact, ImageResult, ModelClient, ReasoningEffort, VideoArtifact, VideoResult } from '../../../packages/model/src/index.js';
import type { PlannerClient } from '../../../packages/intent-router/src/index.js';
import type { SessionStore } from '../../../packages/core/src/index.js';
import type { BotRouting } from './config-bridge.js';
import type { ImagePromptPipeline } from './image-pipeline.js';

/** 把 model 层的图像产物统一成可直接发送/压缩的字符串（url 原样、base64 转 data URL）。 */
export function artifactToString(artifact: ImageArtifact): string {
  if (artifact.kind === 'url') return artifact.data;
  const mime = artifact.mimeType || 'image/png';
  return `data:${mime};base64,${artifact.data}`;
}

export function artifactsToStrings(result: ImageResult): string[] {
  return (result.images || []).map(artifactToString);
}

/** 视频产物 → 可发 QQ 的 file 引用（url 或 data:video/...;base64）。 */
export function videoArtifactToString(artifact: VideoArtifact): string {
  if (artifact.kind === 'url') return artifact.data;
  const mime = artifact.mimeType || 'video/mp4';
  return `data:${mime};base64,${artifact.data}`;
}

export function videoArtifactsToStrings(result: VideoResult): string[] {
  return (result.videos || []).map(videoArtifactToString).filter((u) => String(u || '').trim());
}

export interface ModelDepsOptions {
  client: ModelClient;
  /** 每次调用读取当前路由（支持热重载切节点）。 */
  getRouting: () => BotRouting;
  /** 会话记忆(可选)；提供后 chat 带历史并回存。 */
  sessions?: SessionStore;
  /** chat 系统提示词(可选)。 */
  chatSystemPrompt?: string;
  /** 生图提示词流水线(可选)：模板渲染 + 润色 + 失败安全改写。 */
  pipeline?: ImagePromptPipeline;
  /** 结构化日志器(可选)：记录图片被丢弃等诊断信息。 */
  logger?: { info(message: string, data?: Record<string, unknown>): void; warn(message: string, data?: Record<string, unknown>): void; error(message: string, data?: Record<string, unknown>): void };
}

/**
 * 用 model 层 + 路由实现 bot-engine 需要的下游能力 BotEngineDeps。
 * - chat 带图且模型有 vision 能力时自动走 vision；否则走 chat,并按 sessionId 带入/回存会话记忆;
 * - 生图/改图结果统一转成字符串数组交回引擎。
 * 注：templateId 的模板渲染属于 image/enhance 层职责,model 层只收已渲染的 prompt。
 */
export function createModelBackedDeps(options: ModelDepsOptions): BotEngineDeps {
  const { client, getRouting, sessions, chatSystemPrompt, pipeline, logger } = options;
  return {
    async chat(req) {
      const routing = getRouting();
      const nodeIndex = req.nodeIndex ?? routing.chatNodeIndex;
      const images = (req.images || []).filter(Boolean);
      const videos = (req.videos || []).filter(Boolean);
      // 群聊上下文：@bot 时拉取的最近群聊记录，作为 system 前置注入，让 bot 知道在聊什么。
      const contextSystem = req.context
        ? { role: 'system', content: `【群内最近对话上下文】\n${req.context}\n（请根据@你的消息判断是否与上述上下文相关：相关则结合上下文回复，无关则正常回复用户，不要生硬搬运上下文内容）` }
        : null;
      // 推理模型(gpt-5/o1/o3/o4/codex)需要 reasoning_effort 字段, 否则部分上游代理
      // (如 chatgpt2api) 转发到 /backend-anon/conversation 时会被 OpenAI 拒(403)。
      // 对齐历史 monolith 的 shouldSendReasoningEffort + max_tokens=2000 默认值。
      const maxTokens = req.maxTokens ?? 2000;
      const reasoningEffort = req.reasoningEffort as ReasoningEffort | undefined;
      // 当前对话模型普遍不支持视频理解：把视频 URL 以文字提示注入，避免当图片喂 vision 崩掉。
      const videoNote = videos.length
        ? `\n\n【用户附带了 ${videos.length} 个视频附件，当前模型无法直接解析视频内容；仅保留引用：${videos.slice(0, 3).map((v, i) => `[${i + 1}] ${String(v).slice(0, 120)}`).join(' ')}】`
        : '';
      // 带图对话走 vision，不进会话记忆(图片上下文不便持久化)。
      if (images.length > 0 && client.can(req.model, 'vision')) {
        const promptBase = contextSystem ? `${contextSystem.content}\n\n${req.text}` : req.text;
        const prompt = `${promptBase}${videoNote}`;
        const visionReq: { model: string; prompt: string; imageUrls: string[]; maxTokens: number; reasoningEffort?: ReasoningEffort } = { model: req.model, prompt, imageUrls: images, maxTokens };
        if (reasoningEffort) visionReq.reasoningEffort = reasoningEffort;
        const res = await client.vision(nodeIndex, visionReq);
        return { text: res.text };
      }
      // 模型无 vision 能力:图片被丢弃,记录警告便于排查(不阻塞纯文本回复)。
      if (images.length > 0) {
        logger?.warn('模型无 vision 能力,图片被丢弃', { model: req.model, imageCount: images.length });
      }
      if (videos.length) {
        logger?.info('chat 路径收到视频附件,已降级为文字引用', { model: req.model, videoCount: videos.length });
      }
      const history = sessions && req.sessionId ? sessions.get(req.sessionId) : [];
      const messages: Array<{ role: string; content: unknown }> = [];
      if (chatSystemPrompt) messages.push({ role: 'system', content: chatSystemPrompt });
      if (contextSystem) messages.push(contextSystem);
      for (const m of history) messages.push({ role: m.role, content: m.content });
      messages.push({ role: 'user', content: `${req.text}${videoNote}` });
      const chatReq: { model: string; messages: typeof messages; maxTokens: number; reasoningEffort?: ReasoningEffort; timeoutMs?: number } = { model: req.model, messages, maxTokens };
      if (reasoningEffort) chatReq.reasoningEffort = reasoningEffort;
      if (req.timeoutMs) chatReq.timeoutMs = req.timeoutMs;
      const res = await client.chat(nodeIndex, chatReq);
      const answer = res.text;
      if (sessions && req.sessionId) {
        sessions.append(req.sessionId, { role: 'user', content: req.text }, { role: 'assistant', content: answer });
      }
      return { text: answer };
    },
    async generateImages(req) {
      const routing = getRouting();
      let prompt = req.prompt;
      if (pipeline) {
        try { prompt = await pipeline.prepare({ prompt: req.prompt, templateId: req.templateId }); }
        catch { prompt = req.prompt; }
      }
      try {
        const res = await client.generateImages(routing.imageNodeIndex, {
          model: req.model, prompt, size: req.size, count: req.count, quality: req.quality,
          ...(routing.imageTimeoutMs ? { timeoutMs: routing.imageTimeoutMs } : {}),
        });
        return { images: artifactsToStrings(res) };
      } catch (error) {
        if (pipeline) {
          const safe = await pipeline.safeRewrite(prompt);
          if (safe && safe.trim() && safe !== prompt) {
            const res = await client.generateImages(routing.imageNodeIndex, {
              model: req.model, prompt: safe, size: req.size, count: req.count, quality: req.quality,
              ...(routing.imageTimeoutMs ? { timeoutMs: routing.imageTimeoutMs } : {}),
            });
            return { images: artifactsToStrings(res) };
          }
        }
        throw error;
      }
    },
    async editImage(req) {
      const routing = getRouting();
      const res = await client.editImage(routing.editNodeIndex, {
        model: req.model, prompt: req.prompt, images: req.images, size: req.size, quality: req.quality,
        ...(routing.imageTimeoutMs ? { timeoutMs: routing.imageTimeoutMs } : {}),
        ...(routing.imageEditRequestMode ? { requestMode: routing.imageEditRequestMode } : {}),
      });
      return { images: artifactsToStrings(res) };
    },
    async interrogate(req) {
      const routing = getRouting();
      const res = await client.interrogate(routing.interrogateNodeIndex, {
        model: req.model, imageUrls: req.images, prompt: req.prompt,
        ...(routing.interrogateTimeoutMs ? { timeoutMs: routing.interrogateTimeoutMs } : {}),
      });
      return { text: res.text };
    },
    async generateVideo(req) {
      const routing = getRouting();
      // ModelClient.generateVideo 内部完成异步轮询，此处只等最终 URL。
      const res = await client.generateVideo(routing.videoNodeIndex, {
        model: req.model,
        prompt: req.prompt,
        imageUrl: req.imageUrl,
        duration: req.duration,
        aspectRatio: req.aspectRatio,
        resolution: req.resolution,
        timeoutMs: routing.videoTimeoutMs,
        pollTimeoutMs: routing.videoPollTimeoutMs,
        pollIntervalMs: routing.videoPollIntervalMs,
      });
      const videos = videoArtifactsToStrings(res);
      if (!videos.length) {
        throw new Error('视频生成完成但未返回可播放 URL（可能仍 pending 或上游异常）');
      }
      return { videos };
    },
  };
}

/**
 * ModelClient 后端的意图规划器:自由模式/歧义判定时,intent-router 用它做一次 LLM 判定。
 * 走 freeMode 节点;不具备 vision 时 intent-router 会自动只传文本。
 *
 * 多模态:buildPlannerMessages 会在 visionEnabled 时把 image_url 拼进 messages。
 * OpenAI 兼容(含 xAI grok-4.5)的 /chat/completions 直接透传 content 数组即可识图。
 * 若某条 message content 含 image_url 而模型无 vision 能力,上游可能 4xx —— 由
 * IntentRouter.plannerVisionEnabled 在调用前按档案门控避免盲发。
 */
export function createModelPlanner(client: ModelClient, getNodeIndex: () => number): PlannerClient {
  return {
    async createText(req) {
      const res = await client.chat(getNodeIndex(), {
        model: req.model,
        messages: req.messages,
        timeoutMs: req.timeoutMs,
        maxTokens: req.maxTokens,
      });
      return { text: res.text, raw: res.raw };
    },
  };
}
