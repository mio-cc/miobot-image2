import fs from 'node:fs';
import { normalizeConfig } from '../dist/packages/config/src/index.js';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { toModelNodes } from '../dist/apps/bot/src/config-bridge.js';
import { SunoPromptComposer } from '../dist/apps/bot/src/suno-composer.js';
import { SunoClient } from '../dist/packages/orchestration/src/index.js';

const configPath = String(process.env.MIOBOT_LIVE_CONFIG || '').trim();
if (!configPath) { console.error('MIOBOT_LIVE_CONFIG required'); process.exit(2); }
const exported = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cfg = normalizeConfig(exported.config || exported);
const model = createModelClient({ nodes: toModelNodes(cfg) });
let captured;
const client = { async chat(node, payload) { captured = payload; return model.chat(node, payload); } };
const composer = new SunoPromptComposer(client, () => cfg);
const request = {
  requestId: 'live-suno-prompt', chat: { type: 'private', userId: 'live' }, user: { qq: 'live', role: 'user' },
  text: '写一首非纯音乐原创歌曲，主题是江南雨夜，中文歌词，完整可唱，必须由你写歌词，不要用现成歌曲原词',
  attachments: [], receivedAt: new Date().toISOString(),
};
const spec = await composer.compose({ request: request.text, instrumental: false, language: '中文' }, request);
const sent = String(captured?.messages?.[1]?.content || '');
const custom = String(cfg.orchestration.suno.composerPromptTemplate || '');
const bodies = [];
const suno = new SunoClient({
  baseUrl: 'https://suno.test', apiKey: 'test', model: 'V6', callbackUrl: 'https://bot.test/callback',
  fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ code: 200, data: { taskId: 'live-task' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
await suno.create({
  customMode: spec.customMode, instrumental: spec.instrumental, title: spec.title, style: spec.style,
  lyrics: spec.lyrics, vocalGender: spec.vocalGender, duration: spec.duration,
  styleWeight: spec.styleWeight, weirdnessConstraint: spec.weirdnessConstraint,
  audioWeight: spec.audioWeight, variety: spec.variety, model: spec.model,
});
const body = bodies[0] || {};
console.log(JSON.stringify({
  promptSent: {
    chars: sent.length,
    hasConfiguredTemplate: custom.length > 0 && sent.includes(custom.slice(0, 80)),
    hasOverride: sent.includes('最高优先级覆盖'),
    hasSchema: sent.includes('customMode'),
    hasUserRequest: sent.includes('江南雨夜'),
  },
  spec: {
    customMode: spec.customMode,
    instrumental: spec.instrumental,
    title: spec.title,
    styleChars: String(spec.style || '').length,
    lyricsChars: String(spec.lyrics || '').length,
    vocalGender: spec.vocalGender,
    language: spec.language,
    duration: spec.duration,
    model: spec.model,
  },
  sunoBody: {
    keys: Object.keys(body).sort(),
    customMode: body.customMode,
    instrumental: body.instrumental,
    hasLyrics: typeof body.lyrics === 'string' && body.lyrics.length > 0,
    lyricsChars: typeof body.lyrics === 'string' ? body.lyrics.length : 0,
    hasStyle: typeof body.style === 'string' && body.style.length > 0,
    hasTitle: typeof body.title === 'string' && body.title.length > 0,
    hasPrompt: typeof body.prompt === 'string' && body.prompt.length > 0,
    hasCallback: typeof body.callBackUrl === 'string' && body.callBackUrl.length > 0,
    vocalGender: body.vocalGender,
    invalidForInstrumental: spec.instrumental ? ['lyrics', 'vocalGender', 'audioWeight'].filter((key) => body[key] !== undefined) : [],
  },
}, null, 2));
