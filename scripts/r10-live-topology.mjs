import fs from 'node:fs';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { createWebSearchService } from '../dist/packages/search/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';
import { toolSpecFromCapabilityDescriptor } from '../dist/packages/tool-runtime/src/index.js';

const configPath = String(process.env.MIOBOT_LIVE_CONFIG || '').trim();
if (!configPath) { console.error('MIOBOT_LIVE_CONFIG is required (path to exported Miobot config JSON)'); process.exit(2); }
const exported = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cfg = normalizeConfig(exported.config || exported);
Object.assign(cfg.agent, { enabled: true, mode: 'enforce', mainNodeIndex: Number(cfg.llm.chatNodeIndex || 0), mainModel: String(cfg.llm.chatModel || ''), maxModelRounds: 8, maxToolRounds: 8, turnTimeoutMs: 240000 });
cfg.toolRegistry.enabled = true;
cfg.replyPolicy.enabled = true;
cfg.replyPolicy.defaultVoice = 'off';
for (const key of ['text', 'image', 'multiImage', 'mixed']) cfg.bot.replyStrategies[key] = 'plain';
const model = createModelClient({ nodes: toModelNodes(cfg) });
const search = createWebSearchService({ getConfig: () => cfg });
const descriptors = new Map(builtinCapabilityDescriptors().map((item) => [item.id, item]));
const readOnly = new Set(['web.search', 'image.interrogate', 'file.read', 'audio.music.history', 'audio.music.lyrics']);

function spec(id) {
  const item = descriptors.get(id);
  if (!item) throw new Error('missing descriptor ' + id);
  return toolSpecFromCapabilityDescriptor(item);
}

async function run(name, text, toolIds, options = {}) {
  const calls = [];
  const handlers = {
    'web.search': async (call) => {
      const query = String(call.arguments?.query || call.arguments?.prompt || text);
      const response = await search.search({ query, count: 3, needContent: true, force: true });
      const context = search.formatContext(response);
      return { ok: true, content: context, outputs: [{ kind: 'text', text: context }] };
    },
    'browser.render': (call) => ({ ok: true, content: 'BROWSER_STUB_ACCEPTED ' + String(call.arguments?.url || ''), outputs: [{ kind: 'text', text: 'BROWSER_STUB_ACCEPTED ' + String(call.arguments?.url || '') }] }),
    'image.interrogate': () => ({ ok: true, content: '参考图描述：水墨青花瓷风格，留白构图。', outputs: [{ kind: 'text', text: '参考图描述：水墨青花瓷风格，留白构图。' }] }),
    'image.generate': (call) => ({ ok: true, content: 'IMAGE_STUB_ACCEPTED ' + JSON.stringify(call.arguments || {}), outputs: [{ kind: 'text', text: 'IMAGE_STUB_ACCEPTED' }] }),
    'file.read': () => ({ ok: true, content: '文件内容：这是待总结的测试文本。', outputs: [{ kind: 'text', text: '文件内容：这是待总结的测试文本。' }] }),
    'file.generate': (call) => ({ ok: true, content: 'FILE_STUB_ACCEPTED ' + JSON.stringify(call.arguments || {}), outputs: [{ kind: 'text', text: 'FILE_STUB_ACCEPTED' }] }),
    'audio.music.history': () => ({ ok: true, content: '歌曲历史：recordId=hist-1, globalSeq=1, title=青花瓷', outputs: [{ kind: 'text', text: '歌曲历史：recordId=hist-1, globalSeq=1, title=青花瓷' }] }),
    'audio.music.lyrics': (call) => ({ ok: true, content: '歌词：天青色等烟雨，而我在等你。参数=' + JSON.stringify(call.arguments || {}), outputs: [{ kind: 'text', text: '歌词：天青色等烟雨，而我在等你。' }] }),
    'audio.music.generate': (call) => ({ ok: true, content: 'SONG_STUB_ACCEPTED ' + JSON.stringify(call.arguments || {}), outputs: [{ kind: 'text', text: 'SONG_STUB_ACCEPTED' }] }),
  };
  const host = createAgentHost({
    getConfig: () => cfg,
    client: model,
    sessions: new InMemoryAgentSessionManager(),
    toolBindings: () => toolIds.map((id) => ({ spec: spec(id), handler: async (call) => {
      calls.push({ name: call.name, args: call.arguments });
      return handlers[id](call);
    } })),
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: (id) => readOnly.has(id),
    isMigratedTool: () => true,
  });
  const started = Date.now();
  try {
    const outcome = await host({ text, chatType: 'private', userId: 'live-topology', sessionId: 'private:live-topology', images: options.images });
    return { name, ok: outcome.status === 'completed', status: outcome.status, ms: Date.now() - started, calls, text: outcome.text };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - started, calls, error: error?.message || String(error) };
  }
}

const scenarios = [
  ['song-lyrics-to-suno', '用《青花瓷》这个歌词来生成歌', ['web.search', 'audio.music.generate']],
  ['song-original-lyrics-to-suno', '来一首《青花瓷》，但歌词要你重新原创，不要用现成原词', ['web.search', 'audio.music.generate']],
  ['search-to-browser-render', '帮我把周杰伦官网首页截个图，我不知道网址', ['web.search', 'browser.render']],
  ['image-interrogate-to-generation', '把这张图反推一下，再按这个风格生成一张新图', ['image.interrogate', 'image.generate'], { images: ['data:image/png;base64,AAAA'] }],
  ['history-to-lyrics', '查一下我之前生成的歌，把《青花瓷》的歌词发给我', ['audio.music.history', 'audio.music.lyrics']],
  ['file-read-to-file-generate', '读取这个文件，然后生成一份摘要文件', ['file.read', 'file.generate']],
  ['parallel-search-history', '同时查一下《青花瓷》的资料和我的歌曲历史', ['web.search', 'audio.music.history']],
];
const results = [];
for (const [name, text, tools, options] of scenarios) results.push(await run(name, text, tools, options));
console.log(JSON.stringify(results.map((r) => ({ name: r.name, ok: r.ok, status: r.status, ms: r.ms, calls: r.calls, error: r.error, text: r.text?.slice(0, 160) })), null, 2));
