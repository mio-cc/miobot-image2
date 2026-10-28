import test from 'node:test';
import assert from 'node:assert/strict';
const { fetchTextSafely } = await import('../dist/apps/bot/src/safe-http.js');

test('R22 safe fetch revalidates redirects and truncates large bodies', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'http://private.example/secret' } });
    return new Response('x'.repeat(5000), { status: 200 });
  };
  try {
    await assert.rejects(
      () => fetchTextSafely('https://public.example/start', {
        assertSafeUrl: async (raw) => {
          if (raw.includes('private')) throw new Error('blocked private redirect');
          return new URL(raw);
        },
        maxBytes: 100,
        timeoutMs: 1000,
      }),
      /blocked private redirect/,
    );
    assert.equal(seen.length, 1);
    globalThis.fetch = async () => new Response('x'.repeat(5000), { status: 200 });
    const result = await fetchTextSafely('https://public.example/large', {
      assertSafeUrl: async (raw) => new URL(raw),
      maxBytes: 100,
      timeoutMs: 1000,
    });
    assert.ok(result.text.endsWith('[内容截断]'));
    assert.ok(result.text.length < 200);
  } finally {
    globalThis.fetch = original;
  }
});
