import type { CapabilityDescriptor, CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { validateCapabilityArgs } from '../../../packages/orchestration/src/validation.js';
import type { McpClient, McpToolInfo } from './mcp-client.js';
import { inferEffectFromDescription, inferMcpToolRisk } from './mcp-client.js';
export type { McpParamDefaultRule } from './mcp-client.js';
import type { McpParamDefaultRule } from './mcp-client.js';
// 方案 B（2026-11-07）：歌词结构规范单一来源——子项 schema 含 lyrics 字段时自动注入（通用判据，不认品牌）。
import { MCP_LYRICS_SPEC_HINT } from './suno-lyrics-spec.js';

/**
 * Phase 2（方案 §4.4，D7/D17/D18/D20/D22）：树形根工具——一个 MCP 服务器 = 一个根能力。
 * - 子项不进注册表，作为根元数据（name/summary/inputSchema/effect/riskLevel/enabled）；
 * - 根入参 `{ action, params }`；action 缺省或 `list_actions` 返回子项目录（不触发外部调用）；
 * - 未知子项 → `mcp_unknown_action`（附可用清单与近似建议）；
 * - 子项校验复用 `validateCapabilityArgs`（basePath `$.params`，错误带字段路径）→ `mcp_action_params_invalid`；
 * - 子项级覆盖统一走 `orchestration.capabilityOverrides['mcp.<server>' / 'mcp.<server>.<tool>']`（D22）；
 * - 输出前缀 `[mcp.<server>/<action>]` 标注来源子项，执行错误/诊断均带 action 上下文。
 */

/** 树内子项元数据（不进注册表）。 */
export interface McpChildTool {
  name: string;
  summary: string;
  inputSchema: Record<string, unknown>;
  effect: CapabilityDescriptor['effect'];
  riskLevel: NonNullable<CapabilityDescriptor['riskLevel']>;
  /** 树内待遇：默认 true（allowlist 已管进树）；capabilityOverrides['mcp.<server>.<tool>'].enabled 覆盖。 */
  enabled: boolean;
  /** 显示名覆盖（D22：capabilityOverrides.name）。 */
  displayName?: string;
}

export interface McpCapabilityOverrideInput {
  enabled?: boolean;
  /** 仅根级生效（子项键写入无效——树形根统一门禁，子项不是独立注册的能力）。 */
  approvalRequired?: boolean;
  riskLevel?: CapabilityDescriptor['riskLevel'];
  /** 仅根级生效（子项键写入无效）。 */
  presentationHint?: string;
  name?: string;
  /** 仅根级生效：经 applyCapabilityOverrides → descriptor.timeoutMs → executor 消费（子项键写入无效）。 */
  timeoutMs?: number;
}

function summarize(description: unknown): string {
  return String(description || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 上游 schema 条件必填补丁（按 `serverId.tool` 键）。
 * audio-create 上游没有 required：简单模式要 description、自定义模式要 lyrics、
 * 纯器乐可只传 instrumental=true、MIDI 可只传 midi_upload_id。空 params 应本地即拒，
 * 因此用 anyOf 表达「四选一」，不硬加 required（避免误伤其它模式）。
 */
const CONDITIONAL_REQUIRED_PATCHES: Record<string, unknown[]> = {
  'suno-official.audio-create': [
    { required: ['description'] },
    { required: ['lyrics'] },
    { required: ['instrumental'], properties: { instrumental: { const: true } } },
    { required: ['midi_upload_id'] },
  ],
};

function applyConditionalRequired(serverId: string, toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  const anyOf = CONDITIONAL_REQUIRED_PATCHES[`${serverId}.${toolName}`];
  if (!anyOf || Array.isArray(schema.anyOf)) return schema;
  return { ...schema, anyOf };
}

/**
 * 构造树内子项集：allowlist 命中的工具进树（D14/D6——allowlist 外不进树）；
 * 每个子项应用 capabilityOverrides['mcp.<server>.<tool>']（D22 一票否决）。
 */
export function buildMcpChildTools(
  serverId: string,
  tools: McpToolInfo[],
  overrides: Record<string, McpCapabilityOverrideInput | undefined> = {},
): McpChildTool[] {
  const children: McpChildTool[] = [];
  for (const tool of tools) {
    const name = String(tool.name || '').trim();
    if (!name) continue;
    const override = overrides[`mcp.${serverId}.${name}`];
    const effect = inferEffectFromDescription(String(tool.description || ''), tool.annotations);
    const baseSchema = (tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {}, additionalProperties: true }) as Record<string, unknown>;
    children.push({
      name,
      summary: summarize(tool.description),
      inputSchema: applyConditionalRequired(serverId, name, baseSchema),
      effect,
      riskLevel: override?.riskLevel ?? inferMcpToolRisk(tool),
      enabled: override?.enabled ?? true,
      ...(override?.name ? { displayName: String(override.name).slice(0, 120) } : {}),
    });
  }
  return children;
}

/** 子项集里是否存在歌词类参数（inputSchema.properties.lyrics）——通用判据，不认 Suno 品牌。 */
function hasLyricsField(children: McpChildTool[]): boolean {
  return children.some((child) => {
    const props = (child.inputSchema as { properties?: Record<string, unknown> } | null)?.properties;
    return Boolean(props && typeof props === 'object' && props.lyrics);
  });
}

/** 参数默认值解析：子项级同键**整条覆盖**根级（含锁定标志）——不做字段级合并，简单可预测。 */
export function resolveChildParamDefaults(
  root?: Record<string, McpParamDefaultRule>,
  child?: Record<string, McpParamDefaultRule>,
): Record<string, McpParamDefaultRule> {
  return { ...(root || {}), ...(child || {}) };
}

function formatRuleValue(rule: McpParamDefaultRule): string {
  return `${String(rule.value)}${rule.locked ? '（锁定）' : ''}`;
}

/** 参数默认值的模型可见说明（目录行/description 共用）：每级最多展示 4 键，超出以 … 截断。 */
export function formatParamDefaultsNote(rules: Record<string, McpParamDefaultRule> | undefined): string {
  if (!rules) return '';
  const entries = Object.entries(rules);
  if (!entries.length) return '';
  const shown = entries.slice(0, 4).map(([key, rule]) => `${key}=${formatRuleValue(rule)}`);
  const text = shown.join('、') + (entries.length > 4 ? '…' : '');
  const hasLock = entries.some(([, rule]) => rule.locked);
  return `${hasLock ? '参数默认/锁定：' : '参数默认：'}${text}。`;
}

/** 子项级参数默认值的模型可见摘要（根描述用）：只列配置了默认值的子项，最多 4 条。 */
export function formatChildParamDefaultsSummary(
  childParamDefaults?: Record<string, Record<string, McpParamDefaultRule>>,
): string {
  if (!childParamDefaults) return '';
  const entries = Object.entries(childParamDefaults)
    .filter(([, rules]) => rules && Object.keys(rules).length);
  if (!entries.length) return '';
  const shown = entries.slice(0, 4).map(([tool, rules]) => {
    const keys = Object.entries(rules).slice(0, 2).map(([key, rule]) => `${key}=${formatRuleValue(rule)}`).join('、');
    return `${tool}(${keys})`;
  });
  return `子项参数默认（缺省自动填入，params 显式传值可覆盖）：${shown.join('；')}${entries.length > 4 ? '…' : ''}。`;
}

export function buildMcpRootDescriptor(
  serverId: string,
  children: McpChildTool[],
  override: McpCapabilityOverrideInput = {},
  paramDefaults?: Record<string, McpParamDefaultRule>,
  childParamDefaults?: Record<string, Record<string, McpParamDefaultRule>>,
): CapabilityDescriptor {
  const enabledCount = children.filter((child) => child.enabled).length;
  const lyricsCapable = hasLyricsField(children);
  const defaultsNote = formatParamDefaultsNote(paramDefaults);
  const childDefaultsNote = formatChildParamDefaultsSummary(childParamDefaults);
  const description = [
    `MCP 服务器 ${serverId} 的统一入口工具（树形根，预算按 1 个工具计）。`,
    `含 ${children.length} 个子操作（${enabledCount} 个已启用）。`,
    '调用时传 action（子工具名）与 params（该子工具的参数对象）；',
    'action 传 list_actions 或留空可查看子项清单与参数说明。',
    ...(defaultsNote ? [defaultsNote] : []),
    ...(childDefaultsNote ? [childDefaultsNote] : []),
    ...(lyricsCapable ? [`歌词/文本参数规范：${MCP_LYRICS_SPEC_HINT}`] : []),
  ].join('').slice(0, 800);
  return {
    id: `mcp.${serverId}`,
    version: '1.0.0',
    name: String(override.name || `${serverId} MCP`).slice(0, 120),
    description,
    provider: `mcp:${serverId}`,
    presentationHint: String(override.presentationHint || ''),
    mode: 'sync',
    riskLevel: override.riskLevel ?? 'medium',
    enabled: override.enabled ?? false,
    approvalRequired: override.approvalRequired === true,
    mergeable: false,
    outputKinds: ['text'],
    effect: 'unknown',
    sideEffects: ['external_call'],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '子工具名；传 list_actions 或留空查看可用子项清单' },
        params: { type: 'object', description: lyricsCapable ? '该子工具的参数，结构见 list_actions 返回；歌词/文本参数须带结构标记（规范见工具说明）' : '该子工具的参数，结构见 list_actions 返回' },
      },
      required: ['action'],
    } as CapabilityDescriptor['inputSchema'],
  } as CapabilityDescriptor;
}

/** 近似子项名建议（轻量：包含/前缀命中，不引模糊搜索库）。 */
function suggestActions(children: McpChildTool[], action: string): string[] {
  const lower = action.toLowerCase();
  return children
    .map((child) => child.name)
    .filter((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()))
    .slice(0, 3);
}

/** 目录分级：前 N 项带摘要，其余只列名称/必填/默认，保证任何工具都不会漏。 */
const MAX_DETAIL_ROWS = 60;
const MAX_ENUM_PARAMS = 2;
const MAX_ENUM_VALUES = 8;

/** 行内枚举摘要：只取顶层 enum（含数组 items.enum），最多 2 个参数、每个 8 个值。 */
function formatEnumNote(schema: Record<string, unknown>): string {
  const props = (schema as { properties?: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }> })?.properties;
  if (!props || typeof props !== 'object') return '';
  const parts: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const values = Array.isArray(prop?.enum) ? prop.enum : (Array.isArray(prop?.items?.enum) ? prop.items.enum : null);
    if (!values?.length) continue;
    const shown = values.slice(0, MAX_ENUM_VALUES).map(String).join('|');
    parts.push(`${name}: ${shown}${values.length > MAX_ENUM_VALUES ? '…' : ''}`);
    if (parts.length >= MAX_ENUM_PARAMS) break;
  }
  return parts.join('；');
}

/** anyOf 条件必填摘要（如 audio-create 四选一），帮助模型在目录就能看懂。 */
function formatAnyOfNote(schema: Record<string, unknown>): string {
  const anyOf = (schema as { anyOf?: unknown[] })?.anyOf;
  if (!Array.isArray(anyOf) || !anyOf.length) return '';
  const alternatives = anyOf
    .map((branch) => {
      const node = branch as { required?: unknown; properties?: Record<string, { const?: unknown }> } | null;
      const required = Array.isArray(node?.required) ? node.required.map(String) : [];
      if (!required.length) return '';
      return required
        .map((key) => {
          const constValue = node?.properties?.[key]?.const;
          return constValue === undefined ? key : `${key}=${JSON.stringify(constValue)}`;
        })
        .join('+');
    })
    .filter(Boolean);
  return alternatives.length ? `任一必填：${alternatives.join(' 或 ')}` : '';
}

/** 子项目录文本（list_actions）：名称 + 一行摘要 + required/anyOf 参数提示 + 枚举 + 参数默认值说明。 */
export function formatChildCatalog(
  serverId: string,
  children: McpChildTool[],
  childParamDefaults?: Record<string, Record<string, McpParamDefaultRule>>,
): string {
  if (!children.length) return `mcp.${serverId} 当前没有已进树的子操作（allowlist 为空或目录为空）。`;
  const lines = children.map((child, index) => {
    const required = Array.isArray((child.inputSchema as any)?.required) ? (child.inputSchema as any).required.map(String) : [];
    const defaultsNote = formatParamDefaultsNote(childParamDefaults?.[child.name]);
    const enumNote = formatEnumNote(child.inputSchema);
    const anyOfNote = formatAnyOfNote(child.inputSchema);
    const detail = index < MAX_DETAIL_ROWS
      ? `${child.summary || '（无描述）'}${required.length ? `｜必填参数：${required.join(', ')}` : ''}${anyOfNote ? `｜${anyOfNote}` : ''}${enumNote ? `｜枚举：${enumNote}` : ''}${defaultsNote ? `｜${defaultsNote}` : ''}`
      : `（详情见子项 schema）${required.length ? `｜必填参数：${required.join(', ')}` : ''}${defaultsNote ? `｜${defaultsNote}` : ''}`;
    return `- ${child.name}${child.displayName ? `（${child.displayName}）` : ''}：${detail}${child.enabled ? '' : '｜已停用'}`;
  });
  return [
    `mcp.${serverId} 子操作清单（${children.length} 项${children.length > MAX_DETAIL_ROWS ? `，前 ${MAX_DETAIL_ROWS} 项含摘要，其余仅列名称与必填` : ''}）：`,
    ...lines,
    '调用方式：action=子操作名，params=该子操作的参数对象。',
    ...(hasLyricsField(children) ? ['歌词/文本参数请遵循工具说明中的结构标记规范（[Intro]/[Verse]/[Chorus] 等标记独占一行，标记后只写歌词）。'] : []),
  ].join('\n');
}

/**
 * 树形根工具 handler：action 路由 / list_actions 目录 / 子项校验 / 错误定位（D17/D18）。
 * 参数默认值（2026-11-07）：转发前**确定性合并**——非锁定键仅填缺失，锁定键无论模型传什么都覆盖；
 * 合并发生在 schema 校验之前（锁定值违 schema 由校验层报可读错误，并标注来源）。
 */
export class McpRootToolHandler implements CapabilityHandler {
  constructor(
    private readonly client: McpClient,
    private readonly serverId: string,
    private readonly children: McpChildTool[],
    /** 每子项已解析的参数默认值规则（根级+子项级，键=子项名）。 */
    private readonly childParamDefaults: Record<string, Record<string, McpParamDefaultRule>> = {},
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const base = { jobId: invocation.plan.planId, stepId: invocation.step.id };
    const args = (invocation.step.args || {}) as Record<string, unknown>;
    const action = String(args.action || '').trim();

    if (!action || action === 'list_actions') {
      return {
        ...base,
        status: 'success',
        outputs: [{ kind: 'text', text: formatChildCatalog(this.serverId, this.children, this.childParamDefaults), priority: 10, mergeable: true }],
      };
    }

    const child = this.children.find((item) => item.name === action);
    if (!child) {
      const suggestions = suggestActions(this.children, action);
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: `mcp_unknown_action:${action}（可用子项：${this.children.map((item) => item.name).join(', ') || '无'}${suggestions.length ? `；你是不是想用：${suggestions.join(', ')}` : ''}）`,
        retryable: false,
        diagnostics: { action, serverId: this.serverId },
      };
    }
    if (!child.enabled) {
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: `mcp_action_disabled:${action}（该子项已被停用，可在面板重新开启）`,
        retryable: false,
        diagnostics: { action, serverId: this.serverId },
      };
    }

    const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
      ? args.params as Record<string, unknown>
      : {};
    // 参数默认值合并（确定性层，不靠提示词）：默认填缺失 / 锁定强制覆盖；记录实际生效来源供诊断。
    const rules = this.childParamDefaults[action] || {};
    const merged: Record<string, unknown> = { ...params };
    const appliedLocked: string[] = [];
    const appliedDefault: string[] = [];
    for (const [key, rule] of Object.entries(rules)) {
      if (rule.locked) {
        merged[key] = rule.value;
        appliedLocked.push(key);
      } else if (merged[key] === undefined) {
        merged[key] = rule.value;
        appliedDefault.push(key);
      }
    }
    const validation = validateCapabilityArgs(child.inputSchema, merged, '$.params');
    if (!validation.ok) {
      // 来源标注只看实际注入的键：锁定键的值恒来自配置；默认键仅当「填缺失」时来自配置（模型显式传的不标）。
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: `mcp_action_params_invalid:${action}（${validation.issues.slice(0, 5).map((item) => {
          const key = item.path.replace('$.params.', '');
          const source = rules[key]?.locked ? '［来自锁定配置］' : appliedDefault.includes(key) ? '［来自默认值配置］' : '';
          return `${item.path} ${item.message}${source}`;
        }).join('；')}）`,
        retryable: false,
        diagnostics: { action, serverId: this.serverId, issues: validation.issues.slice(0, 5), ...(appliedLocked.length || appliedDefault.length ? { appliedParamDefaults: { locked: appliedLocked, default: appliedDefault } } : {}) },
      };
    }

    try {
      const result = await this.client.callTool(child.name, merged);
      if (result.isError) {
        // 失败可诊断（2026-11-07 拍板）：上游拒绝（如账号无该模型权限）时透传错误文本，不退化成一句参数错误。
        const upstreamText = result.content
          .filter((item) => String(item?.type) === 'text' && String(item?.text || '').trim())
          .map((item) => String(item.text).trim())
          .join(' ')
          .slice(0, 200);
        return {
          ...base,
          status: 'failed',
          outputs: [],
          error: `mcp_tool_error:${action}${upstreamText ? `：${upstreamText}` : ''}`,
          retryable: false,
          diagnostics: { action, serverId: this.serverId, ...(appliedLocked.length || appliedDefault.length ? { appliedParamDefaults: { locked: appliedLocked, default: appliedDefault } } : {}) },
        };
      }
      const outputs = result.content
        .filter((item) => String(item?.type) === 'text' && String(item?.text || '').trim())
        .map((item) => ({ kind: 'text' as const, text: `[mcp.${this.serverId}/${action}] ${String(item.text)}`, priority: 10, mergeable: true }));
      if (!outputs.length) {
        return { ...base, status: 'failed', outputs: [], error: `mcp_tool_empty_output:${action}`, retryable: true, diagnostics: { action, serverId: this.serverId } };
      }
      return {
        ...base,
        status: 'success',
        outputs,
        diagnostics: {
          action,
          serverId: this.serverId,
          ...(appliedLocked.length || appliedDefault.length ? { appliedParamDefaults: { locked: appliedLocked, default: appliedDefault } } : {}),
        },
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: String((error as Error)?.message || error),
        retryable: true,
        diagnostics: { action, serverId: this.serverId, ...(appliedLocked.length || appliedDefault.length ? { appliedParamDefaults: { locked: appliedLocked, default: appliedDefault } } : {}) },
      };
    }
  }
}
