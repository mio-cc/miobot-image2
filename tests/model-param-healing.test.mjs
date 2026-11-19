// 参数自愈（2026-11-19）：四类错误形态 + snap + multipart 重建。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFix,
  applyLearned,
  describeLearned,
  diagnose,
  extractParamRejection,
  healingKey,
  pickCandidate,
  rememberFix,
  resetLearned,
} from '../dist/packages/model/src/index.js';
import { applyFixToFormData, formDataToRecord } from '../dist/packages/model/src/client.js';

const SIZE_ENUM = ['1024x1024', '1536x1024', '1024x1536'];

test('OpenAI 形态：error.param 直接给出参数名', () => {
  const r = extractParamRejection(400, {
    error: { message: "Unsupported parameter: 'response_format' is not supported with this model.", param: 'response_format', code: 'unsupported_parameter' },
  }, { prompt: 'x', response_format: 'b64_json' });
  assert.ok(r);
  assert.equal(r.shape, 'openai');
  assert.equal(r.param, 'response_format');
  assert.equal(diagnose(400, { error: { message: 'x', param: 'response_format' } }, { prompt: 'x', response_format: 'b64_json' }).action, 'drop');
});

test('OpenAI 形态：use X instead → rename', () => {
  const fix = diagnose(400, {
    error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", param: 'max_tokens' },
  }, { model: 'o3', max_tokens: 100 });
  assert.deepEqual(fix, { action: 'rename', param: 'max_tokens', to: 'max_completion_tokens' });
});

test('FastAPI 形态：detail[].loc 取到 image_size，literal_error 里的枚举被抽出来', () => {
  const payload = {
    detail: [{
      type: 'literal_error',
      loc: ['body', 'image_size', "literal['square_hd','square','portrait_4_3','portrait_16_9','landscape_4_3','landscape_16_9','auto']"],
      msg: "Input should be 'square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9' or 'auto'",
      input: '__invalid__',
    }],
  };
  const r = extractParamRejection(422, payload, { prompt: 'x', image_size: '__invalid__' });
  assert.ok(r);
  assert.equal(r.shape, 'fastapi');
  assert.equal(r.param, 'image_size');
  assert.deepEqual(r.path, ['image_size']);
  assert.ok(r.valueCandidates.includes('portrait_4_3'));
});

test('FastAPI 形态：枚举 + 竖图 → snap 到竖版（方向不能丢）', () => {
  const payload = {
    detail: [{
      type: 'literal_error',
      loc: ['body', 'image_size'],
      msg: "Input should be 'square_hd', 'square', 'portrait_4_3', 'landscape_16_9'",
    }],
  };
  const fix = diagnose(422, payload, { prompt: 'x', image_size: '1152x1536' });
  assert.equal(fix.action, 'snap');
  assert.equal(fix.param, 'image_size');
  // 1152x1536 是竖图(0.75)；只有 portrait_4_3 是竖版
  assert.equal(fix.to, 'portrait_4_3');
});

test('FastAPI 形态：数值越界（value_error）→ 无候选值时 drop，不误判成 snap', () => {
  const payload = { detail: [{ loc: ['body', 'image_size', 'width'], msg: 'width must be at least 16 pixels', type: 'value_error' }] };
  const fix = diagnose(422, payload, { prompt: 'x', image_size: { width: 1, height: 1 } });
  assert.equal(fix.action, 'drop');
  assert.equal(fix.param, 'image_size');
});

test('Anthropic 形态：invalid_request_error + Unexpected field', () => {
  const payload = { error: { type: 'invalid_request_error', message: 'Unexpected field: image_size' } };
  const r = extractParamRejection(400, payload, { prompt: 'x', image_size: '1024x1024' });
  assert.ok(r);
  assert.equal(r.shape, 'anthropic');
  assert.equal(r.param, 'image_size');
});

test('中文形态：尺寸参数不合格 → snap（这正是线上重复报错的场景）', () => {
  const fix = diagnose(400, { error: { message: '尺寸参数不合格' } }, { prompt: 'x', size: '1152x1536' }, {
    candidatesFor: (param) => (param === 'size' ? SIZE_ENUM : undefined),
  });
  assert.equal(fix.action, 'snap');
  assert.equal(fix.param, 'size');
  assert.equal(fix.to, '1024x1536', '竖图必须 snap 到竖版');
});

test('中文形态：size 参数不合法 / 参数 xxx 不合法 / 不支持的参数 xxx', () => {
  const cases = [
    ['size 参数不合法', 'size'],
    ['参数 quality 不合法', 'quality'],
    ['不支持的参数 response_format', 'response_format'],
    ['未知参数 image_urls', 'image_urls'],
  ];
  for (const [message, param] of cases) {
    const fix = diagnose(400, { error: { message } }, { prompt: 'x', [param]: 'v' })
      || diagnose(400, message, { prompt: 'x', [param]: 'v' });
    assert.ok(fix, message + ' 应被识别');
    assert.equal(fix.param, param, message + ' → ' + fix.param);
    assert.equal(fix.action, 'drop', message + ' 无候选值时应 drop');
  }
});

test('中文形态：只有中文词没有英文参数名时按字段提示映射（且必须在请求体里）', () => {
  const hit = diagnose(400, { error: { message: '图片尺寸不合格' } }, { prompt: 'x', size: '999x999' });
  assert.ok(hit);
  assert.equal(hit.param, 'size');
  // 请求体里没有该字段 → 不猜
  assert.equal(diagnose(400, { error: { message: '图片尺寸不合格' } }, { prompt: 'x' }), undefined);
});

test('429 / 500 / 503 一律不当作参数问题', () => {
  for (const status of [429, 500, 503]) {
    assert.equal(diagnose(status, { error: { message: '尺寸参数不合格', param: 'size' } }, { size: '1024x1024' }, { candidatesFor: () => SIZE_ENUM }), undefined, String(status));
  }
});

test('pickCandidate：尺寸按带方向比例，数字按距离，其余优先 auto', () => {
  assert.equal(pickCandidate('1152x1536', SIZE_ENUM), '1024x1536');
  assert.equal(pickCandidate('3840x2160', SIZE_ENUM), '1536x1024');
  assert.equal(pickCandidate('1024x1536', SIZE_ENUM), '1024x1536', '已合法应原样返回');
  assert.equal(pickCandidate('5', ['1', '4', '8']), '4');
  assert.equal(pickCandidate('whatever', ['a', 'auto', 'b']), 'auto');
});

test('learned：snap 会被记住并自动应用到后续请求', () => {
  resetLearned();
  const key = healingKey({ baseUrl: 'https://gw.test/v1', dialect: 'openai' }, 'm1');
  rememberFix(key, { action: 'snap', param: 'size', to: '1024x1536' });
  rememberFix(key, { action: 'drop', param: 'response_format' });
  rememberFix(key, { action: 'rename', param: 'max_tokens', to: 'max_completion_tokens' });
  const applied = applyLearned(key, { prompt: 'x', size: '1152x1536', response_format: 'b64_json', max_tokens: 10 });
  assert.equal(applied.size, '1024x1536');
  assert.equal('response_format' in applied, false);
  assert.equal(applied.max_completion_tokens, 10);
  assert.equal('max_tokens' in applied, false);
  const described = describeLearned(key);
  assert.deepEqual(described.snapped, { size: '1024x1536' });
});

test('applyFix：drop / rename / snap 三种动作', () => {
  assert.deepEqual(applyFix({ a: 1, b: 2 }, { action: 'drop', param: 'a' }), { b: 2 });
  assert.deepEqual(applyFix({ a: 1 }, { action: 'rename', param: 'a', to: 'c' }), { c: 1 });
  assert.deepEqual(applyFix({ a: 1 }, { action: 'snap', param: 'a', to: 9 }), { a: 9 });
});

test('multipart：FormData 也能自愈（以前整条路被跳过）', () => {
  const form = new FormData();
  form.append('model', 'gpt-image-2.6');
  form.append('prompt', 'cat');
  form.append('quality', 'max');
  form.append('size', '1152x1536');

  const flat = formDataToRecord(form);
  assert.deepEqual(flat, { model: 'gpt-image-2.6', prompt: 'cat', quality: 'max', size: '1152x1536' });

  // drop quality
  const dropped = applyFixToFormData(form, { action: 'drop', param: 'quality' });
  const droppedFlat = formDataToRecord(dropped);
  assert.equal('quality' in droppedFlat, false);
  assert.equal(droppedFlat.prompt, 'cat');

  // snap size
  const snapped = applyFixToFormData(form, { action: 'snap', param: 'size', to: '1024x1536' });
  assert.equal(formDataToRecord(snapped).size, '1024x1536');

  // rename
  const renamed = applyFixToFormData(form, { action: 'rename', param: 'quality', to: 'image_quality' });
  const renamedFlat = formDataToRecord(renamed);
  assert.equal(renamedFlat.image_quality, 'max');
  assert.equal('quality' in renamedFlat, false);
});