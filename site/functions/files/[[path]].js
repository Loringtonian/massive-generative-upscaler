// Serves the full-size downloads from the private R2 bucket (binding FILES).
// Only with a signed, short-lived link from /api/download (human check passed).
// Per-visitor rate limit: a Cloudflare WAF rule on /files/ for the custom domain.
import { verify } from '../_sign.js';
const PREFIX = 'files/'; // folder inside the R2 bucket that holds the downloads

export async function onRequestGet({ request, params, env }) {
  const name = (params.path || []).join('/');
  if (!name || name.includes('..')) return new Response('Not found', { status: 404 });
  const url = new URL(request.url);
  if (!(await verify(env.DL_SIGNING_KEY, name, url.searchParams.get('e'), url.searchParams.get('s')))) {
    return new Response('This download link has expired. Go back to the page and press the download button again.', { status: 403 });
  }

  const range = parseRange(request.headers.get('range'));
  const obj = await env.FILES.get(PREFIX + name, range ? { range } : {});
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-disposition', `attachment; filename="${name.split('/').pop()}"`);
  headers.set('cache-control', 'private, no-store');

  if (range && obj.range) {
    const start = obj.range.offset ?? obj.size - obj.range.suffix;
    const length = obj.range.length ?? obj.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

export async function onRequestHead(ctx) {
  const res = await onRequestGet(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}

function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m) return null;
  if (m[1] === '') return m[2] ? { suffix: Number(m[2]) } : null;
  const offset = Number(m[1]);
  return m[2] === '' ? { offset } : { offset, length: Number(m[2]) - offset + 1 };
}
