#!/usr/bin/env node
/**
 * Suno MCP「一次性真实生成」受控脚本。
 *
 * 安全护栏（缺一不可）：
 *   1. 必须显式传 --confirm-live 才会执行；
 *   2. 若 .runtime/suno-mcp-live-once-report.json 已存在，直接拒绝（只准跑一次）；
 *   3. fetchImpl 在真实出网前做硬校验：只允许 readOnlyHint=true 的工具，
 *      以及唯一一次 audio-create；任何其他非只读工具在发出请求前抛错；
 *   4. 对 audio-create 的参数做逐项断言（model=v6-mini / duration=15 / lyrics 逐字节一致 /
 *      instrumental 非 true / 固定 idempotency_key），任一不符即中止；
 *   5. 全程不使用 audio-download（Free 账号下载额度为 0）。
 *
 * 用法：
 *   node scripts/mcp-suno-live-once.mjs --confirm-live
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, '.runtime', 'config.json');
const CREDENTIALS_PATH = path.join(ROOT, '.runtime', 'mcp-credentials.json');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'fixtures', 'suno-mcp-tools.json');
const REPORT_PATH = path.join(ROOT, '.runtime', 'suno-mcp-live-once-report.json');
const SERVER_ID = 'suno-official';
const ROOT_ID = `mcp.${SERVER_ID}`;
const LIVE_KEY = 'miobot-live-once-20261108-audio-create';

const LYRICS = [
  '[Verse]',
  '雨の粒が 窓辺でほどける',
  '傘を忘れた 帰り道',
  '',
  '[Chorus]',
  '夜を巻き戻して もう一度',
  '君の声だけ リフレイン',
  '夜を巻き戻して もう一度',
  '君の声だけ リフレイン',
  '',
  '[Bridge]',
  'レコードは 止まったまま',
  '記憶は まだ歌える',
  '',
  '[Verse]',
  '濡れたセーター 肩に掛けたまま',
  '名前のない朝が 来る',
  '',
  '[Chorus]',
  '夜を巻き戻して もう一度',
  '君の声だけ リフレイン',
  '夜を巻き戻して もう一度',
  '君の声だけ リフレイン',
].join('\n');

const TITLE = '雨音リフレイン・ノート';
const REFERENCED_TITLE = '雨粒のポストカード';
const STYLE = 'city pop, rainy night, warm female vocal, mellow';
const DURATION = 15;

if (!process.argv.includes('--confirm-live')) {
  console.error('拒绝执行：真实生成会消耗约 10 credits，必须显式传 --confirm-live。');
  process.exit(1);
}
if (fs.existsSync(REPORT_PATH)) {
  console.error(`拒绝执行：${path.relative(ROOT, REPORT_PATH)} 已存在，本次只允许真实生成一次。`);
  console.error('若确需重跑，请先人工确认并删除该报告文件。');
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(text) {
  let raw = String(text || '');
  // 根工具输出形如 `[mcp.<server>/<action>] {...}`，先剥离前缀再解析。
  raw = raw.replace(/^\[mcp\.[^\]]+\]\s*/, '');
  const objIndex = raw.indexOf('{');
  const arrIndex = raw.indexOf('[');
  const candidates = [objIndex, arrIndex].filter((index) => index >= 0);
  if (!candidates.length) return null;
  const start = Math.min(...candidates);
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

function collectCredits(value, out = {}, prefix = '') {
  if (!value || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'number' && /credit/i.test(key)) out[pathKey] = item;
    else if (item && typeof item === 'object') collectCredits(item, out, pathKey);
  }
  return out;
}

async function ensureAccessToken() {
  const store = readJson(CREDENTIALS_PATH);
  const credential = store.credentials?.[SERVER_ID];
  if (!credential?.accessToken) throw new Error('缺少 accessToken，请先在面板完成授权');
  let payload = null;
  try { payload = JSON.parse(Buffer.from(credential.accessToken.split('.')[1], 'base64url').toString()); } catch { payload = null; }
  const secondsLeft = payload?.exp ? payload.exp - Math.floor(Date.now() / 1000) : 0;
  if (secondsLeft > 120) return credential;
  const clientId = payload?.client_id;
  if (!clientId || !credential.refreshToken) throw new Error('token 已过期且缺少 client_id/refreshToken，无法自动续期');
  const response = await fetch(credential.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: clientId,
      resource: credential.resource,
    }).toString(),
  });
  if (!response.ok) throw new Error(`token 续期失败：${response.status} ${(await response.text()).slice(0, 120)}`);
  const fresh = await response.json();
  credential.accessToken = fresh.access_token;
  if (fresh.refresh_token) credential.refreshToken = fresh.refresh_token;
  credential.expiresAt = new Date(Date.now() + (Number(fresh.expires_in) || 3600) * 1000).toISOString();
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(store, null, 2), 'utf8');
  return credential;
}

/** 真实传输 + 出网前硬校验 + 全量录制 */
function createLiveTransport({ tools, accessToken }) {
  const ledger = [];
  const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));
  let createAttempts = 0;
  const fetchImpl = async (url, init = {}) => {
    let message = null;
    try { message = JSON.parse(String(init.body || '')); } catch { message = null; }
    const method = String(message?.method || '');
    const entry = { seq: ledger.length + 1, method, url: String(url), at: new Date().toISOString(), network: true };
    const headers = { ...(init.headers || {}) };
    delete headers.authorization;
    entry.requestHeaders = headers;

    if (method === 'tools/call') {
      const name = String(message?.params?.name || '');
      const args = message?.params?.arguments || {};
      entry.tool = name;
      entry.args = args;
      entry.requestBody = String(init.body || '');
      const tool = toolIndex.get(name);
      if (tool?.annotations?.readOnlyHint !== true && name !== 'audio-create') {
        throw new Error(`live_run_blocked_non_readonly_tool:${name}（本次仅允许 1 次 audio-create，禁止 audio-download 等非只读工具）`);
      }
      if (name === 'audio-create') {
        createAttempts += 1;
        if (createAttempts > 1) throw new Error('live_run_second_create_blocked:本次只允许一次 audio-create');
        if (args.model !== 'v6-mini') throw new Error(`live_run_preflight_model:${String(args.model)}`);
        if (args.duration !== DURATION) throw new Error(`live_run_preflight_duration:${String(args.duration)}`);
        if (args.instrumental === true) throw new Error('live_run_preflight_instrumental');
        if (args.lyrics !== LYRICS) throw new Error('live_run_preflight_lyrics_mismatch');
        if (args.title !== TITLE) throw new Error(`live_run_preflight_title:${String(args.title)}`);
        if (args.idempotency_key !== LIVE_KEY) throw new Error(`live_run_preflight_idempotency:${String(args.idempotency_key)}`);
      }
    } else {
      entry.requestBody = String(init.body || '');
    }

    ledger.push(entry);
    const response = await globalThis.fetch(url, init);
    entry.status = response.status;
    const clone = response.clone();
    entry.responseText = await clone.text();
    return response;
  };
  return { fetchImpl, ledger, getCreateAttempts: () => createAttempts };
}

async function probeAudioUrl(audioUrl) {
  if (!audioUrl) return { ok: false, reason: 'no audio url' };
  const head = await fetch(audioUrl, { method: 'HEAD', redirect: 'follow' });
  const headInfo = {
    method: 'HEAD',
    status: head.status,
    contentType: head.headers.get('content-type'),
    contentLength: head.headers.get('content-length'),
    acceptRanges: head.headers.get('accept-ranges'),
  };
  if (head.ok) return { ok: true, ...headInfo };
  if (![403, 405, 501].includes(head.status)) return { ok: false, head: headInfo };
  const controller = new AbortController();
  const ranged = await fetch(audioUrl, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: controller.signal });
  const reader = ranged.body?.getReader();
  let firstChunk = 0;
  if (reader) {
    const { value } = await reader.read();
    firstChunk = value?.byteLength || 0;
    controller.abort();
  }
  return {
    ok: ranged.ok,
    method: 'GET(range)',
    status: ranged.status,
    contentType: ranged.headers.get('content-type'),
    contentLength: ranged.headers.get('content-length'),
    contentRange: ranged.headers.get('content-range'),
    firstChunkBytes: firstChunk,
    head: headInfo,
  };
}

async function main() {
  const { config, server } = (() => {
    const cfg = readJson(CONFIG_PATH);
    const item = (cfg.orchestration?.mcpServers || []).find((entry) => entry.id === SERVER_ID);
    if (!item) throw new Error('config 中找不到 suno-official');
    return { config: cfg, server: item };
  })();
  const fixture = readJson(FIXTURE_PATH);
  const accessToken = await ensureAccessToken();
  const transport = createLiveTransport({ tools: fixture.tools || [], accessToken });
  const { createDryRunHarness, toolsMap } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'mcp-suno-dry-run.mjs')).href);
  const harness = await createDryRunHarness({ server, overrides: config.orchestration?.capabilityOverrides || {}, transport, timeoutMs: 60000, useRealCredentials: true });
  const transcript = { generatedAt: new Date().toISOString(), serverId: SERVER_ID, plan: 'Free', stages: {} };

  async function invoke(action, params) {
    const startedAt = Date.now();
    const result = await harness.invoke({ action, params });
    return {
      action,
      params,
      elapsedMs: Date.now() - startedAt,
      status: result.status,
      error: result.error || null,
      retryable: result.retryable ?? null,
      diagnostics: result.diagnostics || null,
      outputs: (result.outputs || []).map((item) => item.text),
    };
  }

  try {
    // 0. 目录与连接
    transcript.stages.connection = {
      state: harness.manager.statusOf(SERVER_ID),
      toolCount: fixture.toolCount,
      rootRegistered: Boolean(harness.root),
    };

    // 1. credits 快照（前）
    const usageBefore = await invoke('account-usage', {});
    const usageBeforeJson = extractJson(usageBefore.outputs?.[0]);
    transcript.stages.creditBefore = {
      result: usageBefore,
      parsed: usageBeforeJson,
      credits: collectCredits(usageBeforeJson),
    };

    // 2. 唯一一次真实生成
    const requestedParams = {
      lyrics: LYRICS,
      style: STYLE,
      title: TITLE,
      duration: DURATION,
      model: 'v6-mini',
      instrumental: false,
      idempotency_key: LIVE_KEY,
    };
    const createStartedAt = Date.now();
    const createResult = await invoke('audio-create', requestedParams);
    transcript.stages.create = {
      modelRequested: { action: 'audio-create', params: requestedParams },
      result: createResult,
      elapsedMs: Date.now() - createStartedAt,
      defaultMerge: createResult.diagnostics?.appliedParamDefaults || null,
    };
    const createEntry = transport.ledger.findLast?.((entry) => entry.tool === 'audio-create') || [...transport.ledger].reverse().find((entry) => entry.tool === 'audio-create');
    transcript.stages.create.requestBody = createEntry?.requestBody || null;
    transcript.stages.create.requestStatus = createEntry?.status || null;
    transcript.stages.create.responseText = createEntry?.responseText || null;
    const bodyArgs = createEntry?.requestBody ? JSON.parse(createEntry.requestBody)?.params?.arguments : null;
    transcript.stages.create.bodyArgs = bodyArgs;
    transcript.stages.create.lyricsChecks = {
      byteIdentical: bodyArgs?.lyrics === LYRICS,
      inputLength: LYRICS.length,
      sentLength: String(bodyArgs?.lyrics || '').length,
      inputLines: LYRICS.split('\n').length,
      sentLines: String(bodyArgs?.lyrics || '').split('\n').length,
      tagsInput: LYRICS.split('\n').filter((line) => line.trim().startsWith('[')),
      tagsSent: String(bodyArgs?.lyrics || '').split('\n').filter((line) => line.trim().startsWith('[')),
      tagsEachOnOwnLine: String(bodyArgs?.lyrics || '').split('\n').filter((line) => line.trim().startsWith('[')).every((line) => /^\[[^\[\]]+\]$/.test(line.trim())),
      chorusRepeatedVerbatim: (() => {
        const blocks = String(bodyArgs?.lyrics || '').split('[Chorus]').slice(1);
        const normalized = blocks.map((block) => block.trim());
        return normalized.length >= 2 && normalized[0] === normalized[1];
      })(),
    };

    // 3. 解析返回的 clip id
    const createPayload = extractJson(createResult.outputs?.[0]);
    const createdClips = Array.isArray(createPayload) ? createPayload : (createPayload?.clips || createPayload?.data || []);
    const clipIds = createdClips.map((clip) => clip?.id).filter(Boolean);
    transcript.stages.create.createdClips = createdClips;
    transcript.stages.create.clipIds = clipIds;

    if (createResult.status !== 'success') {
      transcript.stages.create.aborted = 'audio-create 失败，按只跑一次规则不重试';
    } else if (!clipIds.length) {
      transcript.stages.create.aborted = '响应中未解析到 clip id，按只跑一次规则不重试';
    } else {
      // 4. 轮询到 complete（只读，不消耗额度）
      const polls = [];
      let finalClips = [];
      for (let round = 1; round <= 40; round += 1) {
        const roundResults = [];
        for (const id of clipIds) {
          const result = await invoke('audio-retrieve', { id });
          const payload = extractJson(result.outputs?.[0]);
          roundResults.push({ id, status: result.status, error: result.error || null, clip: payload });
          if (!payload?.id) result.missingPayload = true;
        }
        polls.push({ round, at: new Date().toISOString(), results: roundResults });
        const states = roundResults.map((item) => String(item.clip?.status || ''));
        finalClips = roundResults.map((item) => item.clip).filter(Boolean);
        const done = states.every((state) => state === 'complete' || state === 'error');
        if (done) break;
        await sleep(10000);
      }
      transcript.stages.polling = polls;

      // 5. 元数据与 URL 检查
      transcript.stages.metadata = finalClips.map((clip) => ({
        id: clip.id,
        status: clip.status,
        title: clip.title ?? clip.metadata?.title ?? null,
        duration: clip.duration ?? clip.metadata?.duration ?? null,
        visibility: clip.visibility ?? clip.metadata?.visibility ?? null,
        style: clip.metadata?.style ?? clip.style ?? clip.tags ?? null,
        tags: clip.metadata?.tags ?? clip.tags ?? null,
        urlCandidates: Object.entries(clip)
          .filter(([key, value]) => typeof value === 'string' && /url/i.test(key) && /^https?:/.test(value))
          .map(([key, value]) => ({ key, value })),
      }));
      const primaryClip = finalClips[0] || {};
      const audioUrl = ['audio_url', 'song_url', 'stream_url', 'url']
        .map((key) => primaryClip?.[key])
        .find((value) => typeof value === 'string' && /^https?:/.test(value))
        || transcript.stages.metadata[0]?.urlCandidates?.[0]?.value;
      transcript.stages.audioUrl = audioUrl || null;
      transcript.stages.audioUrlProbe = await probeAudioUrl(audioUrl);

      // 6. library-list 只读核对
      const library = await invoke('library-list', { limit: 10 });
      const libraryPayload = extractJson(library.outputs?.[0]);
      const items = Array.isArray(libraryPayload) ? libraryPayload : (libraryPayload?.items || libraryPayload?.songs || libraryPayload?.data || []);
      const found = items.filter((item) => clipIds.includes(item?.id));
      transcript.stages.libraryList = {
        result: library,
        itemCount: items.length,
        containsGenerated: found.length > 0,
        generatedItems: found.map((item) => ({
          id: item.id,
          status: item.status,
          title: item.title ?? item.metadata?.title ?? null,
          duration: item.duration ?? item.metadata?.duration ?? null,
          visibility: item.visibility ?? item.metadata?.visibility ?? null,
          audioUrl: item.audio_url || item.song_url || item.stream_url || null,
        })),
      };
    }
  } finally {
    // 7. credits 快照（后）：无论成功失败都记录
    try {
      const usageAfter = await invoke('account-usage', {});
      const usageAfterJson = extractJson(usageAfter.outputs?.[0]);
      transcript.stages.creditAfter = { result: usageAfter, parsed: usageAfterJson, credits: collectCredits(usageAfterJson) };
    } catch (error) {
      transcript.stages.creditAfter = { error: String(error?.message || error) };
    }
    transcript.ledger = transport.ledger.map((entry) => ({
      seq: entry.seq,
      method: entry.method,
      tool: entry.tool || null,
      status: entry.status,
      nonReadOnly: entry.tool ? fixture.tools.find((tool) => tool.name === entry.tool)?.annotations?.readOnlyHint !== true : null,
    }));
    transcript.ledgerCounts = transport.ledger.reduce((acc, entry) => {
      const key = entry.tool || entry.method;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    transcript.createAttempts = transport.getCreateAttempts();
    transcript.referencedTitle = REFERENCED_TITLE;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(transcript, null, 2), 'utf8');
    await harness.manager.close().catch(() => {});
  }

  printSummary(transcript);
}

function printSummary(transcript) {
  const stage = transcript.stages;
  console.log(`真实生成报告 → ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`连接：${JSON.stringify(stage.connection?.state)}｜audio-create 次数：${transcript.createAttempts}`);
  console.log(`credits(before)：${JSON.stringify(stage.creditBefore?.credits)}`);
  console.log(`credits(after) ：${JSON.stringify(stage.creditAfter?.credits)}`);
  console.log(`生成结果：status=${stage.create?.result?.status}｜error=${stage.create?.result?.error || 'none'}`);
  if (stage.create?.bodyArgs) {
    console.log(`最终请求体：model=${stage.create.bodyArgs.model}｜duration=${stage.create.bodyArgs.duration}｜title=${stage.create.bodyArgs.title}`);
    console.log(`歌词校验：byteIdentical=${stage.create.lyricsChecks.byteIdentical}｜tagsOwnLine=${stage.create.lyricsChecks.tagsEachOnOwnLine}｜chorusRepeated=${stage.create.lyricsChecks.chorusRepeatedVerbatim}`);
  }
  if (stage.create?.clipIds?.length) console.log(`clipIds=${JSON.stringify(stage.create.clipIds)}`);
  if (stage.polling) {
    const last = stage.polling[stage.polling.length - 1];
    console.log(`轮询 ${stage.polling.length} 轮，末轮状态：${JSON.stringify(last.results.map((item) => `${item.id}:${item.clip?.status}`))}`);
  }
  if (stage.metadata) {
    for (const item of stage.metadata) {
      console.log(`元数据：id=${item.id}｜status=${item.status}｜title=${item.title}｜duration=${item.duration}｜visibility=${item.visibility}｜style=${JSON.stringify(item.style)}`);
    }
  }
  console.log(`audio url：${stage.audioUrl || '（未取到）'}`);
  console.log(`URL 探测：${JSON.stringify(stage.audioUrlProbe)}`);
  console.log(`library-list：itemCount=${stage.libraryList?.itemCount}｜containsGenerated=${stage.libraryList?.containsGenerated}`);
  console.log(`出网调用统计：${JSON.stringify(transcript.ledgerCounts)}`);
}

await main();
