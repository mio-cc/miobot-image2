import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityDescriptor, CapabilityHandler } from '../../../packages/orchestration/src/index.js';
import type { StructuredLogger } from '../../../packages/logger/src/index.js';

/**
 * T4.2 插件注册 API 的目录加载器。
 *
 * 数据目录 capabilities/*.mjs，模块 default 导出工厂：
 *   export default (ctx) => ({ descriptor, handler })
 * ctx 提供 getConfig / client / logger / dataDir——插件可以拿模型客户端做自己的事。
 * 单个插件加载失败只告警不拖垮启动；成功清单写入 capabilities/plugins.json，
 * web 面板进程（独立进程，不执行插件 JS）读清单展示，实现"面板可见"。
 */

export interface CapabilityPluginContext {
  getConfig: () => unknown;
  client: unknown;
  logger?: StructuredLogger;
  dataDir: string;
}

export interface LoadedCapabilityPlugin {
  descriptor: CapabilityDescriptor;
  handler: CapabilityHandler;
  source: string;
}

export interface CapabilityPluginManifestEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  loadedAt: string;
  descriptor: CapabilityDescriptor;
}

export function pluginManifestPath(capabilitiesDir: string): string {
  return path.join(capabilitiesDir, 'plugins.json');
}

export async function loadCapabilityPlugins(
  capabilitiesDir: string,
  ctx: CapabilityPluginContext,
  register: (plugin: LoadedCapabilityPlugin) => void,
  options: { logger?: StructuredLogger } = {},
): Promise<CapabilityPluginManifestEntry[]> {
  const manifest: CapabilityPluginManifestEntry[] = [];
  let files: string[] = [];
  try {
    files = (await fs.readdir(capabilitiesDir)).filter((file) => file.endsWith('.mjs')).sort();
  } catch {
    return manifest; // 目录不存在 = 无插件，正常路径
  }
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(capabilitiesDir, file)).href);
      const factory = (mod as { default?: unknown; plugin?: unknown }).default || (mod as { plugin?: unknown }).plugin;
      if (typeof factory !== 'function') throw new Error('缺少 default 导出工厂函数 (ctx) => ({ descriptor, handler })');
      const loaded = (factory as (ctx: CapabilityPluginContext) => { descriptor?: CapabilityDescriptor; handler?: CapabilityHandler })(ctx);
      if (!loaded?.descriptor?.id || typeof loaded?.handler?.execute !== 'function') {
        throw new Error('插件形态无效：需要 { descriptor: {id, ...}, handler: { execute } }');
      }
      register({ descriptor: loaded.descriptor, handler: loaded.handler, source: file });
      manifest.push({
        id: loaded.descriptor.id,
        name: String(loaded.descriptor.name || loaded.descriptor.id),
        version: String(loaded.descriptor.version || '-'),
        description: String(loaded.descriptor.description || ''),
        source: file,
        loadedAt: new Date().toISOString(),
        descriptor: loaded.descriptor,
      });
      options.logger?.info('能力插件已加载', { id: loaded.descriptor.id, source: file });
    } catch (error) {
      options.logger?.warn('能力插件加载失败，已跳过', { file, error: String((error as Error)?.message || error) });
    }
  }
  try {
    await fs.mkdir(capabilitiesDir, { recursive: true });
    await fs.writeFile(pluginManifestPath(capabilitiesDir), JSON.stringify({ plugins: manifest }, null, 2), 'utf8');
  } catch (error) {
    options.logger?.warn('能力插件清单写入失败（面板将看不到插件，不影响运行）', { error: String((error as Error)?.message || error) });
  }
  return manifest;
}
