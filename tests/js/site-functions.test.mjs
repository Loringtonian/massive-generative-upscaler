import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../../site/functions/_sign.js';
import { onRequestPost } from '../../site/functions/api/download.js';
import { onRequestGet } from '../../site/functions/files/[[path]].js';

const KEY = 'test-signing-key';
const now = () => Math.floor(Date.now() / 1000);

test('a fresh signature verifies', async () => {
  const exp = String(now() + 60);
  assert.equal(await verify(KEY, 'a.jpg', exp, await sign(KEY, 'a.jpg', exp)), true);
});

test('expired, tampered, wrong-file and keyless links are refused', async () => {
  const exp = String(now() + 60);
  const sig = await sign(KEY, 'a.jpg', exp);
  const old = String(now() - 1);
  assert.equal(await verify(KEY, 'a.jpg', old, await sign(KEY, 'a.jpg', old)), false);
  assert.equal(await verify(KEY, 'a.jpg', exp, sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')), false);
  assert.equal(await verify(KEY, 'b.jpg', exp, sig), false);
  assert.equal(await verify(KEY, 'a.jpg', String(now() + 120), sig), false);
  assert.equal(await verify('', 'a.jpg', exp, sig), false);
  assert.equal(await verify(KEY, 'a.jpg', 'soon', sig), false);
  assert.equal(await verify(KEY, 'a.jpg', exp, ''), false);
});

function fakeBucket(files) {
  return {
    head: async (k) => (k in files ? { size: files[k].length } : null),
    get: async (k, opts = {}) => {
      if (!(k in files)) return null;
      const data = files[k];
      const r = opts.range;
      const body = r ? data.slice(r.offset, r.length ? r.offset + r.length : undefined) : data;
      return { size: data.length, range: r, body, httpEtag: '"e"', writeHttpMetadata: (h) => h.set('content-type', 'image/jpeg') };
    },
  };
}
const env = { DL_SIGNING_KEY: KEY, FILES: fakeBucket({ 'files/a.jpg': new Uint8Array([1, 2, 3, 4, 5]) }) };
const post = (body) => new Request('https://example.com/api/download', { method: 'POST', body: JSON.stringify(body) });

test('download endpoint hands out a signed link that the files endpoint accepts', async () => {
  const res = await onRequestPost({ request: post({ file: 'a.jpg' }), env });
  assert.equal(res.status, 200);
  const { url } = await res.json();
  const u = new URL(url, 'https://example.com');
  const got = await onRequestGet({ request: new Request(u), params: { path: ['a.jpg'] }, env });
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
  const ranged = await onRequestGet({ request: new Request(u, { headers: { range: 'bytes=1-2' } }), params: { path: ['a.jpg'] }, env });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 1-2/5');
});

test('download endpoint rejects bad names, missing files and failed human checks', async () => {
  assert.equal((await onRequestPost({ request: post({ file: '../x' }), env })).status, 404);
  assert.equal((await onRequestPost({ request: post({ file: 'nope.jpg' }), env })).status, 404);
  const bad = new Request('https://example.com/api/download', { method: 'POST', body: '{' });
  assert.equal((await onRequestPost({ request: bad, env })).status, 400);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }));
  try {
    const res = await onRequestPost({ request: post({ file: 'a.jpg', token: 'x' }), env: { ...env, REQUIRE_HUMAN_CHECK: '1', TURNSTILE_SECRET: 's' } });
    assert.equal(res.status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('files endpoint refuses unsigned, expired and traversal requests', async () => {
  const unsigned = await onRequestGet({ request: new Request('https://example.com/files/a.jpg'), params: { path: ['a.jpg'] }, env });
  assert.equal(unsigned.status, 403);
  const exp = now() - 5;
  const expired = await onRequestGet({
    request: new Request(`https://example.com/files/a.jpg?e=${exp}&s=${await sign(KEY, 'a.jpg', exp)}`),
    params: { path: ['a.jpg'] },
    env,
  });
  assert.equal(expired.status, 403);
  const trav = await onRequestGet({ request: new Request('https://example.com/files/x'), params: { path: ['..', 'secret'] }, env });
  assert.equal(trav.status, 404);
});
