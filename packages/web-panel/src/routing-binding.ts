/**
 * 「能力分工」表格里，体检快照与实时配置的取舍。
 *
 * 后端的能力体检是按【已保存的配置】算出来的。面板上改节点/模型只是本地脏状态，
 * 要点保存才回后端——中间这段时间，快照描述的是上一份配置。
 *
 * 之前表格把快照放在 `||` 链的第一位：
 *   binding?.nodeName || config.llm.apiKeys[当前索引]?.name || '—'
 * 快照非空，于是读实时配置的兜底永远轮不到，用户改完节点，那一列纹丝不动。
 *
 * 这里的规则很简单：**「现在选的是哪个节点/模型」以实时配置为准，
 * 「这个组合能不能用」才以体检快照为准，且快照对不上时不给结论。**
 */

export interface CapabilityBindingSnapshot {
  key: string;
  nodeIndex: number;
  nodeName: string;
  model: string;
  operations?: string[];
  source?: string;
  ok: boolean;
  reason?: string;
}

export interface RoutingRowState {
  /** 当前配置里选中的节点索引。 */
  nodeIndex: number;
  /** 当前配置里填的模型 ID。 */
  model: string;
}

/** 快照是否仍然描述着当前这套配置。对不上就不能拿它当事实。 */
export function isBindingFresh(
  binding: CapabilityBindingSnapshot | undefined,
  state: RoutingRowState,
): boolean {
  if (!binding) return false;
  if (Number(binding.nodeIndex) !== (Number(state.nodeIndex) || 0)) return false;
  return String(binding.model || '') === String(state.model || '');
}

/**
 * 表格「节点」列显示什么。
 *
 * 实时配置优先——它才是「现在选的是哪个节点」的唯一事实来源。
 * 节点被删掉、或索引越界时退回快照里的名字，两个都没有就给个占位，
 * 免得那一列直接空掉让人以为没配。
 */
export function resolveNodeName(
  nodeNames: readonly (string | undefined)[],
  state: RoutingRowState,
  binding?: CapabilityBindingSnapshot,
): string {
  const index = Number(state.nodeIndex) || 0;
  const live = String(nodeNames[index] || '').trim();
  if (live) return live;
  const fromSnapshot = String(binding?.nodeName || '').trim();
  if (fromSnapshot) return fromSnapshot;
  return `节点 ${index + 1}`;
}

/**
 * 状态点该显示成什么。
 *
 * 'stale' 是这次新加的一档：改了还没保存时，旧结论已经作废、新的还没算出来。
 * 这种情况既不能显示绿（可能已经改坏了），也不能显示红（可能刚好是改好了），
 * 沿用旧结论则是直接说谎。
 */
export type RoutingRowStatus = 'disabled' | 'stale' | 'ok' | 'broken';

export function resolveRowStatus(
  binding: CapabilityBindingSnapshot | undefined,
  state: RoutingRowState,
  options: { enabled?: boolean } = {},
): RoutingRowStatus {
  if (options.enabled === false) return 'disabled';
  if (!binding) return 'broken';
  return isBindingFresh(binding, state) ? (binding.ok ? 'ok' : 'broken') : 'stale';
}
