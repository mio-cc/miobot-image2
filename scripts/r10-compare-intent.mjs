import fs from 'node:fs';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { createAgentHost } from '../dist/apps/bot/src/agent-host.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { createWebSearchService } from '../dist/packages/search/src/index.js';
import { InMemoryAgentSessionManager } from '../dist/packages/agent-runtime/src/index.js';
import { builtinCapabilityDescriptors } from '../dist/packages/orchestration/src/index.js';
import { toolSpecFromCapabilityDescriptor } from '../dist/packages/tool-runtime/src/index.js';

const configPath = process.env.MIOBOT_LIVE_CONFIG;
if (!configPath) { console.error('MIOBOT_LIVE_CONFIG required'); process.exit(2); }
const exported = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cfg = normalizeConfig(exported.config || exported);
Object.assign(cfg.agent, { enabled: true, mode: 'enforce', mainNodeIndex: Number(cfg.llm.chatNodeIndex || 0), mainModel: String(cfg.llm.chatModel || ''), maxModelRounds: 8, maxToolRounds: 8, turnTimeoutMs: 240000 });
cfg.toolRegistry.enabled = true;
cfg.replyPolicy.enabled = true;
cfg.replyPolicy.defaultVoice = 'off';
for (const key of ['text', 'image', 'multiImage', 'mixed']) cfg.bot.replyStrategies[key] = 'plain';
const model = createModelClient({ nodes: toModelNodes(cfg) });
const search = createWebSearchService({ getConfig: () => cfg });
const ds = new Map(builtinCapabilityDescriptors().map((x) => [x.id, x]));
const spec = (id) => toolSpecFromCapabilityDescriptor(ds.get(id));

async function run(name, text) {
  const calls = [];
  let sunoArgs;
  const host = createAgentHost({
    getConfig: () => cfg,
    client: model,
    sessions: new InMemoryAgentSessionManager(),
    toolBindings: () => [
      { spec: spec('web.search'), handler: async (call) => {
        calls.push({ name: call.name, args: call.arguments });
        const query = String(call.arguments?.query || call.arguments?.prompt || text);
        const response = await search.search({ query, count: 3, needContent: true, force: true });
        const context = search.formatContext(response);
        return { ok: true, content: context, outputs: [{ kind: 'text', text: context }] };
      } },
      { spec: spec('audio.music.generate'), handler: async (call) => {
        calls.push({ name: call.name, args: call.arguments });
        sunoArgs = call.arguments;
        return { ok: true, content: 'SUNO_HANDLER_ACCEPTED', outputs: [{ kind: 'text', text: 'SUNO_HANDLER_ACCEPTED' }] };
      } },
    ],
    preflightToolCall: () => ({ allowed: true }),
    isReadOnlyTool: (id) => id === 'web.search',
    isMigratedTool: () => true,
  });
  const started = Date.now();
  try {
    const out = await host({ text, chatType: 'private', userId: 'intent-compare', sessionId: 'private:intent-compare-' + name });
    const lyrics = String(sunoArgs?.lyrics || '');
    return { name, question: text, status: out.status, ms: Date.now() - started, calls, text: out.text, lyricsSample: lyrics.slice(0, 160), lyricsLength: lyrics.length, hasCanonicalPhrase: /天青色等烟雨|素胚勾勒出青花/.test(lyrics) };
  } catch (error) {
    return { name, question: text, status: 'error', ms: Date.now() - started, calls, error: error?.message || String(error) };
  }
}

const results = [];
results.push(await run('A-existing-lyrics', '来一首《青花瓷》，就要周杰伦那一版的感觉，词别给我乱改'));
results.push(await run('B-original-lyrics', '来一首《青花瓷》，但我想听点全新的，歌词要你自己写，别用现成原词'));
console.log(JSON.stringify(results.map(({ lyricsSample, ...r }) => r), null, 2));
