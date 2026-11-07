import type { CapabilityDescriptor, CapabilityHandler, CapabilityInvocation, ExecutionResult } from '../../../packages/orchestration/src/index.js';
import { validateCapabilityArgs } from '../../../packages/orchestration/src/validation.js';
import type { McpClient, McpToolInfo } from './mcp-client.js';
import { inferEffectFromDescription } from './mcp-client.js';

/**
 * Phase 2（方案 §4.4，D7/D17/D18/D20/D22）：树形根工具——一个 MCP 服务器 = 一个根能力。
 * - 子项不进注册表，作为根元数据（name/summary/inputSchema/effect/riskLevel/enabled）；
 * - 根入参 `{ action, params }`；action 缺省或 `list_actions` 返回子项目录（不触发外部调用）；
 * - 未知子项 → `mcp_unknown_action`（附可用清单与近似建议）；
 * - 子项校验复用 `validateCapabilityArgs`（basePath `$.params`，错误带字段路径）→ `mcp_action_params_invalid`；
 * - 子项级覆盖统一走 `orchestration.capabilityOverrides['mcp.<server>' / 'mcp.<server>.<tool>']`（D22）；
 * - 输出前缀 `[mcp.<server>/<action>]` 标注来源子项，执行错误/诊断均带 action 上下文。
 */

/** MCP 工具 annotations（服务器自述，仅作初筛，D8：不可信，覆盖一票否决）。 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

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

function annotationsOf(tool: McpToolInfo): McpToolAnnotations {
  const raw = (tool as { annotations?: unknown }).annotations;
  return raw && typeof raw === 'object' ? raw as McpToolAnnotations : {};
}

function summarize(description: unknown): string {
  return String(description || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** D8 风险初筛：annotations 优先（readOnly→low / destructive→high），正则兜底，默认 medium。 */
function inferChildRisk(tool: McpToolInfo): NonNullable<CapabilityDescriptor['riskLevel']> {
  const annotations = annotationsOf(tool);
  if (annotations.destructiveHint === true) return 'high';
  if (annotations.readOnlyHint === true) return 'low';
  const description = String(tool.description || '').toLowerCase();
  if (/\b(delete|remove|drop)\b|删除|移除/.test(description)) return 'high';
  if (/\b(read|list|get|query|search|fetch|find)\b|读取|查询|搜索|获取/.test(description)) return 'low';
  return 'medium';
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
    const effect = inferEffectFromDescription(String(tool.description || ''));
    children.push({
      name,
      summary: summarize(tool.description),
      inputSchema: (tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {}, additionalProperties: true }) as Record<string, unknown>,
      effect,
      riskLevel: override?.riskLevel ?? inferChildRisk(tool),
      enabled: override?.enabled ?? true,
      ...(override?.name ? { displayName: String(override.name).slice(0, 120) } : {}),
    });
  }
  return children;
}

/** 根 descriptor：id `mcp.<server>`，默认 deny，description 恒定（分层摘要 ≤500 字符，预算按根计）。 */
export function buildMcpRootDescriptor(
  serverId: string,
  children: McpChildTool[],
  override: McpCapabilityOverrideInput = {},
): CapabilityDescriptor {
  const enabledCount = children.filter((child) => child.enabled).length;
  const description = [
    `MCP 服务器 ${serverId} 的统一入口工具（树形根，预算按 1 个工具计）。`,
    `含 ${children.length} 个子操作（${enabledCount} 个已启用）。`,
    '调用时传 action（子工具名）与 params（该子工具的参数对象）；',
    'action 传 list_actions 或留空可查看子项清单与参数说明。',
  ].join('').slice(0, 500);
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
        params: { type: 'object', description: '该子工具的参数，结构见 list_actions 返回' },
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

/** 子项目录文本（list_actions）：名称 + 一行摘要 + required 参数提示（D17）。 */
export function formatChildCatalog(serverId: string, children: McpChildTool[]): string {
  if (!children.length) return `mcp.${serverId} 当前没有已进树的子操作（allowlist 为空或目录为空）。`;
  const lines = children.slice(0, 40).map((child) => {
    const required = Array.isArray((child.inputSchema as any)?.required) ? (child.inputSchema as any).required.map(String) : [];
    return `- ${child.name}${child.displayName ? `（${child.displayName}）` : ''}：${child.summary || '（无描述）'}${required.length ? `｜必填参数：${required.join(', ')}` : ''}${child.enabled ? '' : '｜已停用'}`;
  });
  return [
    `mcp.${serverId} 子操作清单（${children.length} 项${children.length > 40 ? '，仅显示前 40 项' : ''}）：`,
    ...lines,
    '调用方式：action=子操作名，params=该子操作的参数对象。',
  ].join('\n');
}

/** 树形根工具 handler：action 路由 / list_actions 目录 / 子项校验 / 错误定位（D17/D18）。 */
export class McpRootToolHandler implements CapabilityHandler {
  constructor(
    private readonly client: McpClient,
    private readonly serverId: string,
    private readonly children: McpChildTool[],
  ) {}

  async execute(invocation: CapabilityInvocation): Promise<ExecutionResult> {
    const base = { jobId: invocation.plan.planId, stepId: invocation.step.id };
    const args = (invocation.step.args || {}) as Record<string, unknown>;
    const action = String(args.action || '').trim();

    if (!action || action === 'list_actions') {
      return {
        ...base,
        status: 'success',
        outputs: [{ kind: 'text', text: formatChildCatalog(this.serverId, this.children), priority: 10, mergeable: true }],
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
    const validation = validateCapabilityArgs(child.inputSchema, params, '$.params');
    if (!validation.ok) {
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: `mcp_action_params_invalid:${action}（${validation.issues.slice(0, 5).map((item) => `${item.path} ${item.message}`).join('；')}）`,
        retryable: false,
        diagnostics: { action, serverId: this.serverId, issues: validation.issues.slice(0, 5) },
      };
    }

    try {
      const result = await this.client.callTool(child.name, params);
      if (result.isError) {
        return {
          ...base,
          status: 'failed',
          outputs: [],
          error: `mcp_tool_error:${action}`,
          retryable: false,
          diagnostics: { action, serverId: this.serverId },
        };
      }
      const outputs = result.content
        .filter((item) => String(item?.type) === 'text' && String(item?.text || '').trim())
        .map((item) => ({ kind: 'text' as const, text: `[mcp.${this.serverId}/${action}] ${String(item.text)}`, priority: 10, mergeable: true }));
      if (!outputs.length) {
        return { ...base, status: 'failed', outputs: [], error: `mcp_tool_empty_output:${action}`, retryable: true, diagnostics: { action, serverId: this.serverId } };
      }
      return { ...base, status: 'success', outputs, diagnostics: { action, serverId: this.serverId } };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        outputs: [],
        error: String((error as Error)?.message || error),
        retryable: true,
        diagnostics: { action, serverId: this.serverId },
      };
    }
  }
}
