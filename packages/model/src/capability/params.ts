/**
 * 请求参数规则：同一个 OpenAI 兼容协议，各家对**参数本身**的接受度并不一致。
 *
 * 这些不是「模型能干什么」（那是 profiles.ts 的能力档案），而是「请求体该长什么样」：
 * 同一份 payload 发给 gpt-4o 正常、发给 o3 会被官方直接 400。
 *
 * 规则只依赖模型名，因此是纯函数，方言可以直接调用而不需要拿到 registry。
 * 名字判断不出来的（中转、反代、没见过的新模型）一律走最大公约数，
 * 剩下的交给 client 的参数自愈（paramHealing）在运行期学。
 */

/** 改图请求体形态。官方 gpt-image 只认 multipart，xAI 明确只认 JSON。 */
export type ImageEditTransport = 'multipart' | 'json-images' | 'json-image';

/**
 * 剥掉 provider 前缀。中转常见 `openai/gpt-5`、`anthropic/claude-opus-5` 这种写法，
 * 不先剥掉的话所有前缀判断都会失效。
 */
export function stripProviderPrefix(model: string): string {
  const name = String(model || '').trim();
  const slash = name.lastIndexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** CLIProxyAPI 用 `模型名(high)` 这种括号后缀表示推理档位，判定前要去掉。 */
export function stripEffortSuffix(model: string): string {
  return String(model || '').replace(/\(([^)]*)\)\s*$/, '').trim();
}

export function normalizeModelId(model: string): string {
  return stripEffortSuffix(stripProviderPrefix(model)).toLowerCase();
}

/** o 系列 / gpt-5 各代 / codex 属于推理模型；gpt-5-chat 是普通对话模型，不算。 */
export function isReasoningModel(model: string): boolean {
  const m = normalizeModelId(model);
  if (!m) return false;
  if (/^gpt-5[.\d]*-chat/.test(m)) return false;
  if (/^(o[1-9])(-|$)/.test(m)) return true;
  if (/^gpt-5/.test(m)) return true;
  if (/codex/.test(m)) return true;
  return false;
}

/**
 * 输出长度参数名。
 * 官方对 o 系列与 gpt-5 系列拒收 max_tokens，必须用 max_completion_tokens，
 * 且该错误不带任何可自动降级的提示，不分流就是必然 400。
 */
export function tokenParamFor(model: string): 'max_tokens' | 'max_completion_tokens' {
  return isReasoningModel(model) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * 推理模型的输出预算要给足——推理 token 与正文共用这个额度，
 * 给小了经常推理没跑完就被截断，拿到一个空 content。
 */
export function defaultTokenBudget(model: string): number {
  return isReasoningModel(model) ? 16000 : 4000;
}

/** o1-mini / o1-preview 与 gpt-5-chat 不接受 reasoning_effort，发了会 400。 */
export function supportsReasoningEffort(model: string): boolean {
  const m = normalizeModelId(model);
  if (!isReasoningModel(m)) return false;
  if (/^o1-(mini|preview)/.test(m)) return false;
  return true;
}

/** 推理模型不接受 temperature（官方固定为 1）。 */
export function supportsTemperature(model: string): boolean {
  return !isReasoningModel(model);
}

/**
 * 是否下发 response_format。
 * gpt-image 系列恒定返回 b64_json，传这个参数官方直接 400 Unknown parameter。
 */
export function supportsResponseFormat(model: string): boolean {
  const m = normalizeModelId(model);
  return !/^(gpt-image|chatgpt-image)/.test(m);
}

/**
 * 改图请求体形态的尝试顺序。
 * 顺序排错会让每次改图都先白白失败一轮：
 * 官方 gpt-image 只认 multipart/form-data，xAI 官方文档明确说不支持 multipart。
 */
export function imageEditTransportsFor(model: string): ImageEditTransport[] {
  const m = normalizeModelId(model);
  if (/^(gpt-image|chatgpt-image|dall-e)/.test(m)) return ['multipart', 'json-image', 'json-images'];
  if (/^grok/.test(m)) return ['json-image', 'json-images', 'multipart'];
  return ['json-images', 'json-image', 'multipart'];
}
