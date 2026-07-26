/**
 * 面板读配置时把密钥打码，写回时再还原。
 *
 * 此前 GET /api/config 会把全部节点的 API Key、Napcat token、prompts.chat key
 * 以及面板密码本身明文发给浏览器。任何一次 XSS、一次共享的浏览器会话、
 * 甚至一次带 devtools 的截屏，都会连带泄露全部凭据。
 *
 * 打码值是由真实值确定性推导出来的，因此前端不需要任何改动：
 * 原样把读到的配置提交回来时，我们能认出「这一项没被改过」并保留原值；
 * 用户真的输入了新密钥，值就对不上打码结果，于是按新值保存。
 */

/** 单值路径（点分）。 */
const SECRET_PATHS = [
  'panel.passwordSeed',
  'napcat.token',
  'promptsChat.apiKey',
  'bot.tts.apiKey',
] as const;

export function maskSecretValue(value: unknown): string {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (raw.length <= 8) return '••••••••';
  return `${raw.slice(0, 3)}••••••••${raw.slice(-4)}`;
}

function isMaskOf(incoming: unknown, stored: unknown): boolean {
  const raw = String(incoming ?? '');
  if (!raw || !raw.includes('••••')) return false;
  return raw === maskSecretValue(stored);
}

function getPath(target: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), target);
}

function setPath(target: unknown, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split('.');
  const last = keys.pop() as string;
  const parent = keys.reduce<any>((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), target);
  if (parent && typeof parent === 'object') parent[last] = value;
}

/** 深拷贝一份配置并把所有密钥字段替换为打码值。 */
export function maskConfigSecrets<T>(config: T): T {
  const clone = JSON.parse(JSON.stringify(config ?? null)) as any;
  if (!clone || typeof clone !== 'object') return clone;

  for (const dottedPath of SECRET_PATHS) {
    const current = getPath(clone, dottedPath);
    if (typeof current === 'string' && current) setPath(clone, dottedPath, maskSecretValue(current));
  }

  const nodes = clone?.llm?.apiKeys;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (typeof node.key === 'string' && node.key) {
        node.hasKey = true;
        node.key = maskSecretValue(node.key);
      } else {
        node.hasKey = false;
      }
    }
  }

  return clone as T;
}

/**
 * 保存前还原打码字段。incoming 会被就地修改；stored 是当前生效的配置。
 * 前端提交的可能是整份配置，也可能是补丁，两种都能处理。
 */
export function unmaskConfigSecrets(incoming: unknown, stored: unknown): unknown {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;

  for (const dottedPath of SECRET_PATHS) {
    const submitted = getPath(incoming, dottedPath);
    if (submitted === undefined) continue;
    if (isMaskOf(submitted, getPath(stored, dottedPath))) {
      setPath(incoming, dottedPath, getPath(stored, dottedPath));
    }
  }

  const submittedNodes = (incoming as any)?.llm?.apiKeys;
  const storedNodes = (stored as any)?.llm?.apiKeys;
  if (Array.isArray(submittedNodes)) {
    submittedNodes.forEach((node: any, index: number) => {
      if (!node || typeof node !== 'object') return;
      delete node.hasKey;
      // 节点按下标对应；下标越界（新增节点）时没有旧值可还原，按提交值处理。
      const storedKey = Array.isArray(storedNodes) ? storedNodes[index]?.key : undefined;
      if (isMaskOf(node.key, storedKey)) node.key = storedKey;
    });
  }

  return incoming;
}
