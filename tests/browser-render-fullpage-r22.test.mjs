import test from 'node:test';
import assert from 'node:assert/strict';

const { buildCodeDocument } = await import('../dist/packages/browser-render/src/index.js');

test('R22 fullPage code render does not clip long tables', async () => {
  const full = await buildCodeDocument({
    format: 'html', title: '榜单', width: 1080, height: 1200, fullPage: true,
    html: '<h1>榜单</h1><table><tbody><tr><td>1</td></tr></tbody></table>',
  });
  assert.match(full, /overflow-y:visible/);
  assert.match(full, /overflow-x:hidden/);
  assert.doesNotMatch(full, /html,body\{margin:0;padding:0;width:100%;height:100%;overflow:hidden/);
  const clipped = await buildCodeDocument({
    format: 'html', title: '作品', width: 1080, height: 1080, fullPage: false,
    html: '<h1>作品</h1>',
  });
  assert.match(clipped, /overflow:hidden/);
});
