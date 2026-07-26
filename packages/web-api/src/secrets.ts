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
 *
 * ── 节点密钥为什么要 keyRef ────────────────────────────────
 * 节点是数组，最初按**下标**跟旧值配对。用户在面板上删掉中间一个节点后，
 * 后面每个节点的下标都前移了一位，于是 isMaskOf 全部落空，
 * 那串圆点被当成「用户新输入的密钥」原样落盘——真实密钥内存和磁盘同时被覆盖，
 * 而且 `sk-••••••••1234` 是 maskSecretValue 的不动点，面板上照样显示「已设置」，
 * 再保存也改不回来。删掉第 1 个节点就等于报废后面所有节点。
 *
 * 现在打码时给每个节点写一个 keyRef（打码那一刻的下标）。它挂在节点对象上，
 * 节点被 splice/重排时会跟着一起走，所以还原时按 keyRef 而不是按当前下标去取旧值。
 * normalizeConfig 重建节点对象时会自然把它丢掉，不会落盘。
 *
 * 最后还有一道兜底：还原完再扫一遍所有凭据字段，只要还带着打码哨兵就拒绝保存。
 * 宁可让用户看到一条明确的报错，也不能把凭据写成一串圆点。
 */

/** 单值路径（点分）。 */
const SECRET_PATHS = [
  'panel.passwordSeed',
  'napcat.token',
  'promptsChat.apiKey',
  'bot.tts.apiKey',
  'huggingFace.token',
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
    nodes.forEach((node: any, index: number) => {
      if (!node || typeof node !== 'object') return;
      // keyRef 跟着节点对象走，重排/删除后仍能找回它自己的旧密钥。
      node.keyRef = index;
      if (typeof node.key === 'string' && node.key) {
        node.hasKey = true;
        node.key = maskSecretValue(node.key);
      } else {
        node.hasKey = false;
      }
    });
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
      // 优先用 keyRef 找旧值：面板删/移动节点后当前下标已经错位，
      // 按下标取会拿到邻居的密钥（或取不到），从而把圆点串当成新密钥写进去。
      const ref = Number.isInteger(node.keyRef) ? Number(node.keyRef) : index;
      delete node.keyRef;
      const storedKey = Array.isArray(storedNodes) ? storedNodes[ref]?.key : undefined;
      if (isMaskOf(node.key, storedKey)) node.key = storedKey;
    });
  }

  return incoming;
}

/** 打码哨兵。凭据里出现它，只可能是还原失败或用户粘了别处的打码值。 */
const MASK_SENTINEL = '••••';

/**
 * 找出还原之后仍然带着打码哨兵的凭据字段。
 *
 * 出现这种情况只有两种可能，两种都不能落盘：
 *   1. 还原逻辑没配上对（例如导入的是别人机器上打码过的配置，值对不上本机任何旧值）；
 *   2. 用户手工粘了一串圆点进去。
 * 直接写进 config.json 的话，上游调用全部 401、NapCat 掉线、面板密码变成一串圆点，
 * 而且原值已经被覆盖、无法找回。
 */
export function findUnresolvedSecrets(config: unknown): string[] {
  const bad: string[] = [];
  const contains = (value: unknown) => typeof value === 'string' && value.includes(MASK_SENTINEL);

  for (const dottedPath of SECRET_PATHS) {
    if (contains(getPath(config, dottedPath))) bad.push(dottedPath);
  }

  const nodes = (config as any)?.llm?.apiKeys;
  if (Array.isArray(nodes)) {
    nodes.forEach((node: any, index: number) => {
      if (node && typeof node === 'object' && contains(node.key)) {
        bad.push(`llm.apiKeys[${index}].key（${node.name || '未命名节点'}）`);
      }
    });
  }

  return bad;
}
