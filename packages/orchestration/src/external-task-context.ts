import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * T2.8：外部异步任务的提交上下文。
 *
 * executor 在 dispatch 前进入该上下文（绑定 stepId/capability/report），
 * 深层执行链（如 ComfyUI 生图经 legacy 适配器 → app.handle → 画布管线 →
 * comfyui 模块）拿不到 CapabilityInvocation，靠 AsyncLocalStorage 把
 * reportExternalTask 一路带到底层提交点——prompt_id/taskId 一到手立即上报，
 * 崩溃重启后才有"查远端对账"的依据。
 */
export interface ExternalTaskScope {
  stepId: string;
  capability: string;
  report: (taskId: string) => void;
}

const storage = new AsyncLocalStorage<ExternalTaskScope>();

export function runWithExternalTaskScope<T>(scope: ExternalTaskScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** 底层提交点（handler 内任意深度）调用；不在编排 dispatch 上下文内时是安全的 no-op。 */
export function reportExternalTaskFromHandler(taskId: string): void {
  const scope = storage.getStore();
  if (scope) scope.report(taskId);
}
