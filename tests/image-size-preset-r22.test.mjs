import test from 'node:test';
import assert from 'node:assert/strict';
const { resolveImageSize, mergeImageUrls } = await import('../dist/apps/bot/src/capability-model.js');

test('R22 image size presets map to concrete dimensions', () => {
  assert.deepEqual(resolveImageSize('portrait'), { size: '1024x1536', width: 1024, height: 1536 });
  assert.deepEqual(resolveImageSize('landscape'), { size: '1536x1024', width: 1536, height: 1024 });
  assert.deepEqual(resolveImageSize('portrait-3-4'), { size: '1152x1536', width: 1152, height: 1536 });
  assert.deepEqual(resolveImageSize('square'), { size: '1024x1024', width: 1024, height: 1024 });
  assert.deepEqual(resolveImageSize('auto'), {});
  assert.deepEqual(resolveImageSize('1024x768'), { size: '1024x768', width: 1024, height: 768 });
  assert.deepEqual(resolveImageSize('weird'), { size: 'weird' });
});

test("R22 image.edit imageUrl joins attachment refs", () => {
  assert.deepEqual(mergeImageUrls(["local:a.jpg"], "https://cdn.example/b.jpg"), ["local:a.jpg", "https://cdn.example/b.jpg"]);
  assert.deepEqual(mergeImageUrls(["local:a.jpg", "local:a.jpg"], "local:a.jpg"), ["local:a.jpg"]);
});
