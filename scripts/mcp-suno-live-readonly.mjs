#!/usr/bin/env node
/**
 * Suno MCP「真实生成之后」的只读取证脚本——不消耗任何生成/下载额度。
 *
 * 前置条件：`.runtime/suno-mcp-live-once-report.json` 已存在（唯一一次 audio-create 已完成）。
 * 本脚本只做只读收尾：
 *   audio-wait(ids, until=complete) → audio-retrieve ×N → library-list → account-usage
 *   → 对取到的音频 URL 做 HEAD（失败退化为 Range GET）
 *
 * 硬护栏（出网前校验，缺一不可）：
 *   1. 必须显式传 --confirm-readonly；
 *   2. 出网层只允许 annotations.readOnlyHint === true 的工具；
 *      audio-create / audio-download / 任何写操作在发出 HTTP 之前直接抛错；
 *   3. 若检测到 audio-create 调用尝试，立即中止并标记 live violation；
 *   4. 结果合并回 live-once 报告，不覆盖原始生成证据。
 *
 * 用法：
 *   node scripts/mcp-suno-live-readonly.mjs --confirm-readonly
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
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ROUNDS = 30;

if (!process.argv.includes('--confirm-readonly')) {
  console.error('拒绝执行：必须显式传 --confirm-readonly（本脚本仅做只读工具调用）。');
  process.exit(1);
}
if (!fs.existsSync(REPORT_PATH)) {
  console.error(`拒绝执行：找不到 ${path.relative(ROOT, REPORT_PATH)}，请先完成唯一一次真实生成。`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 剥离根工具输出前缀 `[mcp.<server>/<action>] ` 后再解析 JSON。 */
function extractJson(text) {
  let raw = String(text || '');
  const prefix = /^\[mcp\.[^\]]+\]\s*/;
  if (prefix.test(raw)) raw = raw.replace(prefix, '');
  try { return JSON.parse(raw); } catch { return null; }
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

/** 只读传输：出网前硬校验 readOnlyHint；录制完整请求/响应。 */
function createReadOnlyTransport({ tools }) {
  const ledger = [];
  const toolIndex = new Map(tools.map((tool) => [tool.name, tool]));
  const violations = [];
  const fetchImpl = async (url, init = {}) => {
    let message = null;
    try { message = JSON.parse(String(init.body || '')); } catch { message = null; }
    const method = String(message?.method || '');
    const entry = {
      seq: ledger.length + 1,
      method,
      url: String(url),
      at: new Date().toISOString(),
      network: true,
    };
    if (method === 'tools/call') {
      const name = String(message?.params?.name || '');
      entry.tool = name;
      entry.args = message?.params?.arguments || {};
      entry.requestBody = String(init.body || '');
      const tool = toolIndex.get(name);
      if (!tool) {
        violations.push(`unknown_tool:${name}`);
        throw new Error(`readonly_run_blocked_unknown_tool:${name}`);
      }
      if (tool.annotations?.readOnlyHint !== true) {
        violations.push(`non_readonly:${name}`);
        throw new Error(`readonly_run_blocked_non_readonly_tool:${name}`);
      }
      if (name === 'audio-create') {
        violations.push('audio-create_attempt');
        throw new Error('readonly_run_blocked_audio_create');
      }
      if (name === 'audio-download') {
        violations.push('audio-download_attempt');
        throw new Error('readonly_run_blocked_audio_download');
      }
    } else {
      entry.requestBody = String(init.body || '');
    }
    ledger.push(entry);
    const response = await globalThis.fetch(url, init);
    entry.status = response.status;
    entry.responseText = await response.clone().text();
    return response;
  };
  return { fetchImpl, ledger, violations };
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
  const ranged = await fetch(audioUrl, { headers: { Range: 'bytes=0-1023' }, redirect: 'follow' });
  let firstChunkBytes = 0;
  try {
    const buffer = await ranged.arrayBuffer();
    firstChunkBytes = buffer.byteLength;
  } catch { firstChunkBytes = 0; }
  return {
    ok: ranged.ok,
    method: 'GET(range)',
    status: ranged.status,
    contentType: ranged.headers.get('content-type'),
    contentLength: ranged.headers.get('content-length'),
    contentRange: ranged.headers.get('content-range'),
    firstChunkBytes,
    head: headInfo,
  };
}

/**
 * audio-retrieve 描述里给出的真实音频流地址：`GET /v0/audio/{id}/stream`。
 * 只读探测：HEAD 优先，若不允许 HEAD 则退化为 Range GET（只读 1KB）。
 */
async function probeAudioStream(id, accessToken) {
  const candidates = [
    { url: `https://api.suno.com/v0/audio/${id}/stream`, auth: true },
    { url: `https://api.suno.com/v0/audio/${id}/stream/`, auth: true },
    { url: `https://cdn1.suno.ai/${id}.mp3`, auth: false },
    { url: `https://cdn2.suno.ai/${id}.mp3`, auth: false },
  ];
  const attempts = [];
  for (const candidate of candidates) {
    const headers = candidate.auth ? { authorization: `Bearer ${accessToken}` } : {};
    try {
      const head = await fetch(candidate.url, { method: 'HEAD', headers, redirect: 'follow' });
      attempts.push({
        url: candidate.url,
        method: 'HEAD',
        status: head.status,
        contentType: head.headers.get('content-type'),
        contentLength: head.headers.get('content-length'),
        acceptRanges: head.headers.get('accept-ranges'),
      });
      if (head.ok) {
        return { ok: true, url: candidate.url, method: 'HEAD', status: head.status, contentType: head.headers.get('content-type'), contentLength: head.headers.get('content-length'), attempts };
      }
      if (![403, 404, 405, 501, 503].includes(head.status)) continue;
      const controller = new AbortController();
      const ranged = await fetch(candidate.url, { headers: { ...headers, Range: 'bytes=0-1023' }, redirect: 'follow', signal: controller.signal });
      const reader = ranged.body?.getReader();
      let firstChunkBytes = 0;
      let preview = '';
      if (reader) {
        const { value } = await reader.read();
        firstChunkBytes = value?.byteLength || 0;
        preview = value ? new TextDecoder().decode(value).slice(0, 160) : '';
        controller.abort();
      }
      const attempt = {
        url: candidate.url,
        method: 'GET(range)',
        status: ranged.status,
        contentType: ranged.headers.get('content-type'),
        contentLength: ranged.headers.get('content-length'),
        contentRange: ranged.headers.get('content-range'),
        firstChunkBytes,
        bodyPreview: preview,
      };
      attempts.push(attempt);
      if (ranged.ok) return { ok: true, ...attempt, attempts };
    } catch (error) {
      attempts.push({ url: candidate.url, method: 'HEAD', error: String(error?.message || error) });
    }
  }
  return { ok: false, attempts };
}

function pickClipIds(report) {
  const responseText = report?.stages?.create?.responseText;
  if (typeof responseText === 'string' && responseText.trim()) {
    try {
      const envelope = JSON.parse(responseText);
      const texts = (envelope?.result?.content || []).filter((item) => item?.type === 'text').map((item) => item?.text);
      for (const text of texts) {
        const payload = extractJson(text);
        if (Array.isArray(payload?.clip_ids) && payload.clip_ids.length) return payload.clip_ids.map(String);
        if (Array.isArray(payload?.clips) && payload.clips.length) {
          const ids = payload.clips.map((clip) => clip?.id).filter(Boolean).map(String);
          if (ids.length) return ids;
        }
      }
    } catch { /* fallthrough */ }
  }
  const existing = report?.stages?.create?.clipIds;
  if (Array.isArray(existing) && existing.length) return existing.map(String);
  return [];
}

async function main() {
  const cfg = readJson(CONFIG_PATH);
  const server = (cfg.orchestration?.mcpServers || []).find((entry) => entry.id === SERVER_ID);
  if (!server) throw new Error('config 中找不到 suno-official');
  const fixture = readJson(FIXTURE_PATH);
  const report = readJson(REPORT_PATH);
  const clipIds = pickClipIds(report);
  if (!clipIds.length) throw new Error('live-once 报告中找不到 clip id，无法继续只读取证');

  const accessToken = await ensureAccessToken();
  const transport = createReadOnlyTransport({ tools: fixture.tools || [] });
  const { createDryRunHarness } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'mcp-suno-dry-run.mjs')).href);
  const harness = await createDryRunHarness({
    server,
    overrides: cfg.orchestration?.capabilityOverrides || {},
    transport,
    timeoutMs: 240000,
    useRealCredentials: true,
  });

  const followup = {
    capturedAt: new Date().toISOString(),
    mode: 'readonly',
    clipIds,
    stages: {},
  };

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
    followup.stages.connection = {
      state: harness.manager.statusOf(SERVER_ID),
      toolCount: fixture.toolCount,
      rootRegistered: Boolean(harness.root),
    };

    // 1. credits 快照（生成后、只读收尾前）
    const usageBefore = await invoke('account-usage', {});
    followup.stages.creditBeforeReadonly = {
      result: usageBefore,
      parsed: extractJson(usageBefore.outputs?.[0]),
      credits: collectCredits(extractJson(usageBefore.outputs?.[0])),
    };

    // 2. audio-wait 等到 complete（只读，服务端不扣生成额度）
    const wait = await invoke('audio-wait', { ids: clipIds, until: 'complete' });
    followup.stages.audioWait = {
      result: wait,
      parsed: wait.outputs.map((text) => extractJson(text)).filter(Boolean),
      clips: (() => {
        const parsed = wait.outputs.map((text) => extractJson(text)).filter(Boolean);
        const found = [];
        for (const payload of parsed) {
          if (Array.isArray(payload?.clips)) found.push(...payload.clips);
          else if (Array.isArray(payload?.data)) found.push(...payload.data);
          else if (payload?.id) found.push(payload);
        }
        return found;
      })(),
    };

    // 3. 轮询 audio-retrieve 直到 complete（audio-wait 若已返回 complete 则一轮即止）
    const polls = [];
    let finalClips = [];
    for (let round = 1; round <= MAX_POLL_ROUNDS; round += 1) {
      const roundResults = [];
      for (const id of clipIds) {
        const result = await invoke('audio-retrieve', { id });
        const payload = extractJson(result.outputs?.[0]);
        roundResults.push({ id, status: result.status, error: result.error || null, clip: payload });
      }
      polls.push({ round, at: new Date().toISOString(), results: roundResults });
      finalClips = roundResults.map((item) => item.clip).filter(Boolean);
      const states = roundResults.map((item) => String(item.clip?.status || ''));
      if (states.every((state) => state === 'complete' || state === 'error')) break;
      if (round === MAX_POLL_ROUNDS) break;
      await sleep(POLL_INTERVAL_MS);
    }
    followup.stages.polling = polls;

    // 4. 元数据与 URL
    followup.stages.metadata = finalClips.map((clip) => ({
      id: clip.id,
      status: clip.status,
      title: clip.title ?? clip.metadata?.title ?? null,
      duration: clip.duration ?? clip.metadata?.duration ?? null,
      visibility: clip.visibility ?? clip.metadata?.visibility ?? null,
      style: clip.metadata?.style ?? clip.style ?? null,
      tags: clip.metadata?.tags ?? clip.tags ?? null,
      urlCandidates: Object.entries(clip)
        .filter(([key, value]) => typeof value === 'string' && /url/i.test(key) && /^https?:/.test(value))
        .map(([key, value]) => ({ key, value })),
      raw: clip,
    }));

    const primaryClip = finalClips[0] || {};
    const audioUrl = ['audio_url', 'song_url', 'stream_url', 'url']
      .map((key) => primaryClip?.[key])
      .find((value) => typeof value === 'string' && /^https?:/.test(value))
      || followup.stages.metadata[0]?.urlCandidates?.[0]?.value
      || null;
    followup.stages.audioUrl = audioUrl;
    followup.stages.audioUrlProbes = [];
    for (const item of followup.stages.metadata) {
      const candidate = ['audio_url', 'song_url', 'stream_url', 'url']
        .map((key) => item.raw?.[key])
        .find((value) => typeof value === 'string' && /^https?:/.test(value))
        || item.urlCandidates?.[0]?.value
        || null;
      followup.stages.audioUrlProbes.push({ id: item.id, url: candidate, probe: await probeAudioUrl(candidate) });
    }
    followup.stages.audioStreamProbes = [];
    for (const id of clipIds) {
      followup.stages.audioStreamProbes.push({ id, probe: await probeAudioStream(id, accessToken.accessToken) });
    }
    followup.stages.audioStreamAccess = followup.stages.audioStreamProbes.map((item) => {
      const blocked = (item.probe?.attempts || []).find((attempt) => attempt.status === 403 && /stream/i.test(String(attempt.bodyPreview || '')));
      return {
        id: item.id,
        directStreamAvailable: item.probe?.ok === true,
        blockedReason: blocked?.bodyPreview || null,
      };
    });

    // 5. library-list 只读核对
    const library = await invoke('library-list', { limit: 20 });
    const libraryPayload = extractJson(library.outputs?.[0]);
    const items = Array.isArray(libraryPayload)
      ? libraryPayload
      : (libraryPayload?.items || libraryPayload?.songs || libraryPayload?.clips || libraryPayload?.data || []);
    const found = items.filter((item) => clipIds.includes(String(item?.id)));
    followup.stages.libraryList = {
      result: library,
      parsed: libraryPayload,
      itemCount: items.length,
      containsGenerated: found.length > 0,
      generatedItems: found,
    };

    // 6. 生成后 credits 对比（完全生成完毕后再读一次）
    followup.stages.creditAfterReadonly = {
      result: await invoke('account-usage', {}),
      parsed: null,
      credits: {},
    };
    const last = followup.stages.creditAfterReadonly.result;
    followup.stages.creditAfterReadonly.parsed = extractJson(last.outputs?.[0]);
    followup.stages.creditAfterReadonly.credits = collectCredits(followup.stages.creditAfterReadonly.parsed);

    followup.stages.checks = {
      allComplete: finalClips.every((clip) => String(clip?.status) === 'complete'),
      allHaveTitle: finalClips.every((clip) => String(clip?.title ?? clip?.metadata?.title ?? '').length > 0),
      allHaveAudioUrl: followup.stages.audioUrlProbes.every((item) => Boolean(item.url)),
      allUrlsOk: followup.stages.audioUrlProbes.every((item) => item.probe?.ok === true),
      allStreamsOk: followup.stages.audioStreamProbes.every((item) => item.probe?.ok === true),
      streamContentTypes: followup.stages.audioStreamProbes.map((item) => item.probe?.contentType ?? null),
      streamContentLengths: followup.stages.audioStreamProbes.map((item) => item.probe?.contentLength ?? null),
      libraryContainsGenerated: followup.stages.libraryList.containsGenerated,
      noNonReadonlyCalls: transport.violations.length === 0,
      durations: finalClips.map((clip) => clip?.duration ?? clip?.metadata?.duration ?? null),
      visibilities: finalClips.map((clip) => clip?.visibility ?? clip?.metadata?.visibility ?? null),
    };
  } finally {
    followup.stages.violations = transport.violations.slice();
    followup.ledger = transport.ledger.map((entry) => ({
      seq: entry.seq,
      method: entry.method,
      tool: entry.tool || null,
      status: entry.status,
      args: entry.args || null,
    }));
    followup.ledgerCounts = transport.ledger.reduce((acc, entry) => {
      const key = entry.tool || entry.method;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    // 合并回 live-once 报告（保留原始证据）
    const merged = { ...report };
    merged.stages = { ...(report.stages || {}), readonlyFollowup: followup };
    if (Array.isArray(report?.stages?.create)) merged.stages.create = report.stages.create;
    const create = { ...(report?.stages?.create || {}) };
    if (!create.clipIds?.length) create.clipIds = clipIds;
    create.lyricsChecks = create.lyricsChecks ? { ...create.lyricsChecks } : {};
    create.lyricsChecks.chorusRepeatedVerbatim = (() => {
      const lyrics = String(create?.bodyArgs?.lyrics || '');
      const blocks = lyrics.split(/^\[Chorus\]\s*$/m).slice(1);
      const stanzas = blocks.map((block) => block.split(/^\[[^\]]+\]\s*$/m)[0].trim());
      return stanzas.length >= 2 && stanzas[0] === stanzas[1];
    })();
    merged.stages.create = create;
    for (const key of ['creditBefore', 'creditAfter']) {
      const stage = merged.stages[key];
      if (!stage) continue;
      const parsed = extractJson(stage?.result?.outputs?.[0]);
      merged.stages[key] = { ...stage, parsed, credits: collectCredits(parsed) };
    }
    merged.readonlyFollowupAt = followup.capturedAt;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(merged, null, 2), 'utf8');
    await harness.manager.close().catch(() => {});
  }

  printSummary(followup);
}

function printSummary(followup) {
  const stage = followup.stages;
  console.log(`只读取证完成 → ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`clipIds=${JSON.stringify(followup.clipIds)}`);
  console.log(`audio-wait：status=${stage.audioWait?.result?.status}｜error=${stage.audioWait?.result?.error || 'none'}｜elapsedMs=${stage.audioWait?.result?.elapsedMs}`);
  const lastPoll = stage.polling?.[stage.polling.length - 1];
  console.log(`audio-retrieve：${stage.polling?.length} 轮｜末轮 ${JSON.stringify(lastPoll?.results?.map((item) => `${item.id}:${item.clip?.status}`))}`);
  for (const item of stage.metadata || []) {
    console.log(`元数据：id=${item.id}｜status=${item.status}｜title=${item.title}｜duration=${item.duration}｜visibility=${item.visibility}｜style=${item.style}`);
  }
  for (const item of stage.audioUrlProbes || []) {
    console.log(`URL：${item.url}`);
    console.log(`  探测：${JSON.stringify(item.probe)}`);
  }
  for (const item of stage.audioStreamAccess || []) {
    console.log(`音频流：id=${item.id}｜可直接播放=${item.directStreamAvailable}｜拒绝原因=${item.blockedReason || '（无）'}`);
  }
  console.log(`library-list：itemCount=${stage.libraryList?.itemCount}｜containsGenerated=${stage.libraryList?.containsGenerated}`);
  console.log(`credits(before) ：${JSON.stringify(stage.creditBeforeReadonly?.credits)}`);
  console.log(`credits(after)  ：${JSON.stringify(stage.creditAfterReadonly?.credits)}`);
  console.log(`checks：${JSON.stringify(stage.checks)}`);
  console.log(`只读违规尝试：${JSON.stringify(stage.violations)}｜出网统计：${JSON.stringify(followup.ledgerCounts)}`);
}

await main();
