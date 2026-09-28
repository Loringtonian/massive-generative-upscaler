// HMAC-SHA256 signing for short-lived download links. Key: Pages secret DL_SIGNING_KEY.
const enc = new TextEncoder();
async function key(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export async function sign(secret, name, exp) {
  const mac = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`${name}|${exp}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function verify(secret, name, exp, sig) {
  if (!secret || !sig || !/^\d+$/.test(exp || '') || Number(exp) < Date.now() / 1000) return false;
  const good = await sign(secret, name, exp);
  if (good.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < good.length; i++) diff |= good.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
