// POST /api/download {file, token} -> {url}
// Checks the invisible "are you human" token (Cloudflare Turnstile), then hands out a
// download link that works for LINK_SECONDS only. Secrets: TURNSTILE_SECRET, DL_SIGNING_KEY.
import { sign } from '../_sign.js';
const PREFIX = 'files/'; // folder inside the R2 bucket that holds the downloads
const LINK_SECONDS = 300;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  const file = String(body.file || '');
  if (!/^[\w.-]+$/.test(file) || !(await env.FILES.head(PREFIX + file))) return json({ error: 'not found' }, 404);

  // Human check only while switched on (Pages env var REQUIRE_HUMAN_CHECK=1). Off by default so
  // visitors feel no friction; turn it on if you see abuse.
  if (env.REQUIRE_HUMAN_CHECK === '1' && !(await humanOk(request, env, body))) return json({ error: 'human check failed' }, 403);

  const exp = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  const sig = await sign(env.DL_SIGNING_KEY, file, exp);
  return json({ url: `/files/${encodeURIComponent(file)}?e=${exp}&s=${sig}` });
}

async function humanOk(request, env, body) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', String(body.token || ''));
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.append('remoteip', ip);
  const check = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
    .then((r) => r.json())
    .catch(() => ({}));
  return check.success === true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
