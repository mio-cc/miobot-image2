import type { WebApiRequest } from '../../web-api/src/index.js';

/** admin 响应：状态码放宽为 number（含 501/502 等 web-api 未覆盖的码）。结构与 WebApiResponse 兼容。 */
export interface AdminResponse<T = unknown> {
  status: number;
  body: T;
}

/** 复用 web-api 的请求形状（method/path/headers/body），传输无关。 */
export type AdminRequest = WebApiRequest;

/** 一个外部集成处理器：拿到请求体，返回完整响应（含错误码）。由 apps/admin 用 Node 能力实现。 */
export type AdminHandler = (body: unknown) => Promise<AdminResponse> | AdminResponse;

/** Codex 子系统：逻辑复杂且强外部依赖，作为可选注入服务整体接入。 */
export interface CodexService {
  handle(method: string, path: string, body: unknown): Promise<AdminResponse> | AdminResponse;
}

/**
 * admin-service 的可注入外部集成。全部可选：未提供时对应路由返回 501（未配置），
 * 而不是让整个后台崩。真实实现（fetch 上游模型、连 napcat 测试、调 ModelClient 生图测试、Codex CLI）
 * 由 apps/admin 提供。
 */
export interface AdminServiceDeps {
  fetchModels?: AdminHandler;
  fetchHuggingFaceModels?: AdminHandler;
  testNapcat?: AdminHandler;
  testImage?: AdminHandler;
  templatesConvert?: AdminHandler;
  codex?: CodexService;
}
