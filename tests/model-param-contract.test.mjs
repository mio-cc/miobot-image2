// 参数契约（2026-11-19）：fixture 是**真实抓取**的 fal OpenAPI（6.8KB），
// 不是手写的假数据。RSC 外壳用真实格式包装真实 payload。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDescriptionConstraints,
  contractFromOpenApi,
  createContract,
  extractFalSpecFromHtml,
  extractOpenAiYamlContract,
  findRequestSchemaName,
  mergeContract,
  parseContract,
  parseSizeProse,
} from '../dist/packages/model/src/index.js';
import { FileModelContractStore } from '../dist/apps/bot/src/model-contract-store.js';

const SPEC = JSON.parse(fs.readFileSync('tests/fixtures/fal-gpt-image-2.6.openapi.json', 'utf8'));

function wrapAsRsc(spec) {
  // 复刻 fal 文档页的真实形态：self.__next_f.push([1,"<escaped json>"])
  const payload = JSON.stringify({ openapi: spec });
  const escaped = JSON.stringify(payload).slice(1, -1);
  return '<html><script>self.__next_f.push([1,"' + escaped + '"])</script></html>';
}

test('RSC 解析：能从 fal 文档页格式里抽出真实 OpenAPI', () => {
  const spec = extractFalSpecFromHtml(wrapAsRsc(SPEC));
  assert.ok(spec, '应当解析出 spec');
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.components.schemas.GPTImage26TextToImageRequest);
});

test('RSC 解析：普通 HTML / 空串 / 坏 JSON 一律返回 undefined 而不抛错', () => {
  assert.equal(extractFalSpecFromHtml('<html>nothing</html>'), undefined);
  assert.equal(extractFalSpecFromHtml(''), undefined);
  assert.equal(extractFalSpecFromHtml('self.__next_f.push([1,"{bad json}"])'), undefined);
});

test('契约：从真实 spec 提出 image_size/quality/output_format/background/prompt', () => {
  const contract = contractFromOpenApi(SPEC, { key: 'k', model: 'openai/gpt-image-2.6/sunburst/text-to-image', op: 'image.generate' });
  assert.ok(contract);
  assert.deepEqual(contract.required, ['prompt']);
  for (const name of ['prompt', 'image_size', 'quality', 'output_format', 'background', 'num_images']) {
    assert.ok(contract.params[name], name + ' 缺失');
  }
  assert.equal(contract.params.quality.kind, 'enum');
  assert.deepEqual(contract.params.quality.enum, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(contract.params.image_size.kind, 'size');
  assert.deepEqual(contract.params.image_size.enum, ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9', 'auto']);
  assert.equal(contract.source, 'schema');
});

test('契约：image_size 的数值约束能从 description 散文里提出来（真实原文）', () => {
  const contract = contractFromOpenApi(SPEC, { key: 'k', model: 'm', op: 'image.generate' });
  const size = contract.params.image_size.size;
  assert.equal(size.multipleOf, 16, 'must 抽出 multiples of 16');
  assert.equal(size.maxEdge, 3840, 'must 抽出 max edge 3840px');
  assert.equal(size.aspectMax, 3, 'must 抽出 aspect ratio <= 3:1');
  assert.deepEqual(size.pixels, { min: 655360, max: 8294400 });
});

test('契约：ImageSize 子 schema 的 width/height 是 integer（$ref 已解析）', () => {
  const spec = SPEC;
  assert.equal(spec.components.schemas.ImageSize.properties.width.type, 'integer');
  assert.equal(spec.components.schemas.ImageSize.properties.height.type, 'integer');
  const contract = contractFromOpenApi(SPEC, { key: 'k', model: 'm', op: 'image.generate' });
  assert.equal(contract.params.image_size.kind, 'size', '$ref 到 ImageSize 应识别成 size 参数');
});

test('契约：output_compression 带上 onlyFor 条件', () => {
  const contract = contractFromOpenApi(SPEC, { key: 'k', model: 'm', op: 'image.generate' });
  assert.deepEqual(contract.params.output_compression.onlyFor, { param: 'output_format', values: ['jpeg', 'webp'] });
});

test('契约：findRequestSchemaName 优先用 paths 里的 requestBody', () => {
  assert.equal(findRequestSchemaName(SPEC), 'GPTImage26TextToImageRequest');
});

test('散文解析：四种句式各自命中', () => {
  const parsed = parseSizeProse('both dimensions as multiples of 16, max edge 3840px, aspect ratio <= 3:1, total pixels between 655,360 and 8,294,400');
  assert.equal(parsed.limits.multipleOf, 16);
  assert.equal(parsed.limits.maxEdge, 3840);
  assert.equal(parsed.limits.aspectMax, 3);
  assert.deepEqual(parsed.limits.pixels, { min: 655360, max: 8294400 });
  assert.equal(parsed.matched.length, 4);
});

test('散文解析：无关文本不误伤', () => {
  const parsed = parseSizeProse('A cute baby sea otter, maximum length 32000 characters');
  assert.deepEqual(parsed.limits, {});
  assert.deepEqual(parsed.matched, []);
});

test('applyDescriptionConstraints：只作用于 kind=size 的参数', () => {
  const base = createContract({
    key: 'k', model: 'm', op: 'image.generate', source: 'schema',
    params: { prompt: { kind: 'string' }, image_size: { kind: 'size' } },
  });
  const result = applyDescriptionConstraints(base, 'multiples of 32, max edge 2048px');
  assert.deepEqual(result.appliedTo, ['image_size']);
  assert.equal(result.contract.params.image_size.size.multipleOf, 32);
  assert.equal(result.contract.params.image_size.size.maxEdge, 2048);
  assert.equal(result.contract.params.prompt.size, undefined);
});

test('OpenAI 官方 yaml：能提出 quality 的 8 个枚举值与 size 的自动/档位', () => {
  const yaml = [
    '    CreateImageRequest:',
    '      type: object',
    '      properties:',
    '        size:',
    '          anyOf:',
    '            - type: string',
    '            - type: string',
    '              enum:',
    '                - 1024x1024',
    '                - 1536x1024',
    '                - 1024x1536',
    '                - auto',
    '        quality:',
    '          anyOf:',
    '            - type: string',
    '              enum:',
    '                - low',
    '                - medium',
    '                - high',
    '                - xhigh',
    '                - max',
    '                - auto',
    '                - standard',
    '                - hd',
    '        n:',
    '          type:',
    '            - integer',
    '          minimum: 1',
    '          maximum: 10',
    '          default: 1',
    '        prompt:',
    '          type: string',
    '    NextSchema:',
    '      type: object',
  ].join('\n');
  const contract = extractOpenAiYamlContract(yaml);
  assert.ok(contract, 'yaml 应能解析');
  assert.deepEqual(contract.params.quality.enum, ['low', 'medium', 'high', 'xhigh', 'max', 'auto', 'standard', 'hd']);
  assert.deepEqual(contract.params.size.enum, ['1024x1024', '1536x1024', '1024x1536', 'auto']);
  assert.equal(contract.params.n.min, 1);
  assert.equal(contract.params.n.max, 10);
  assert.equal(contract.params.prompt.kind, 'string');
});

test('parseContract 容错：缺字段/坏 source/坏参数都只丢那一条', () => {
  assert.equal(parseContract(null), undefined);
  assert.equal(parseContract({ key: 'k' }), undefined);
  assert.equal(parseContract({ key: 'k', model: 'm', op: 'o', source: 'bogus' }), undefined);
  const ok = parseContract({
    key: 'k', model: 'm', op: 'image.generate', source: 'learned',
    params: { good: { kind: 'enum', enum: ['a'] }, bad: { kind: 'nonsense' }, alsoBad: 'string' },
  });
  assert.ok(ok);
  assert.deepEqual(Object.keys(ok.params), ['good']);
});

test('mergeContract：learned 不覆盖 schema 的 source，但能补 transform', () => {
  const base = createContract({ key: 'k', model: 'm', op: 'image.generate', source: 'schema', params: { image_size: { kind: 'size' } } });
  const merged = mergeContract(base, {
    source: 'learned',
    transforms: { image_size: { '1152x1536': '1024x1536' } },
    notes: ['learned size snap'],
  });
  assert.equal(merged.source, 'schema', '更可靠的来源不该被降级');
  assert.equal(merged.transforms.image_size['1152x1536'], '1024x1536');
  assert.ok(merged.notes.includes('learned size snap'));
});

test('落盘：原子写、损坏文件不影响启动、坏条目被跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-contract-'));
  const file = path.join(dir, 'model-contracts.json');
  const store = new FileModelContractStore({ filePath: file });
  const contract = contractFromOpenApi(SPEC, { key: 'fal|https://fal.run::abc::gpt-image-2.6', model: 'openai/gpt-image-2.6/sunburst/text-to-image', op: 'image.generate' });
  store.set(contract);
  store.flush();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(Object.keys(parsed.entries).length, 1);
  assert.equal(fs.existsSync(file + '.tmp'), false, '临时文件必须被 rename 掉');

  // 损坏文件：不抛错，条目为空
  fs.writeFileSync(file, '{ not json', 'utf8');
  const broken = new FileModelContractStore({ filePath: file });
  assert.deepEqual(broken.list(), []);

  // 坏条目被跳过、好条目保留
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { good: contract, bad: { key: 'only-key' } } }), 'utf8');
  const mixed = new FileModelContractStore({ filePath: file });
  assert.equal(mixed.list().length, 1);
  assert.equal(mixed.list()[0].key, contract.key);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('落盘：findByModel 能按模型名找到（同名多节点返回多条）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miobot-contract2-'));
  const store = new FileModelContractStore({ filePath: path.join(dir, 'c.json') });
  const a = createContract({ key: 'a', model: 'gpt-image-2.6', op: 'image.generate', source: 'schema' });
  const b = createContract({ key: 'b', model: 'gpt-image-2.6', op: 'image.generate', source: 'learned' });
  const c = createContract({ key: 'c', model: 'flux/schnell', op: 'image.generate', source: 'schema' });
  store.set(a); store.set(b); store.set(c);
  assert.equal(store.findByModel('gpt-image-2.6').length, 2);
  assert.equal(store.findByModel('GPT-Image-2.6').length, 2, '大小写不敏感');
  assert.equal(store.findByModel('flux/schnell').length, 1);
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});
test('真实官方 yaml：keyword/数字参数类型正确（不是纸上样本）', async () => {
  const yamlPath = '_tmp/docs/openai-openapi.yaml';
  if (!fs.existsSync(yamlPath)) {
    // 没有本地缓存时跳过（不联网，保证测试可离线跑）
    return;
  }
  const yaml = fs.readFileSync(yamlPath, 'utf8');
  const contract = extractOpenAiYamlContract(yaml);
  assert.ok(contract, '真实官方 yaml 必须能解析');
  assert.equal(contract.params.n.kind, 'int');
  assert.equal(contract.params.n.min, 1);
  assert.equal(contract.params.n.max, 10);
  assert.equal(contract.params.output_compression.kind, 'int');
  assert.deepEqual(contract.params.output_format.enum, ['png', 'webp', 'jpeg', 'gif', 'svg']);
  assert.equal(contract.params.quality.enum.includes('xhigh'), true);
  assert.equal(contract.params.quality.enum.includes('max'), true);
  // enum 里不该混进 null（那是 type 联合的回声）
  for (const spec of Object.values(contract.params)) {
    if (spec.enum) assert.equal(spec.enum.includes('null'), false, 'enum 不该含 null');
  }
});
