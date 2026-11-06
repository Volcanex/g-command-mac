'use strict';

// G-Command's standing sign-in to G Studio as Gabriel (g-studio contracts.md
// "Owner key"). The owner key lives only here in the main process: encrypted
// with safeStorage (Keychain-backed on macOS) in userData, never in
// config.json, a renderer, a log or git. When the studio partition has no live
// studio session, the main process trades the key for an ordinary session
// token over HTTPS and puts it in the partition's cookie jar, so the embedded
// studio page just finds itself signed in.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'studio-owner-key.bin';
const KEY_RE = /^gsok1\.([A-Za-z0-9_-]{11})\.[A-Za-z0-9_-]{43}$/;
const COOKIE = '__Host-gs_session';
const TIMEOUT_MS = 8000;

function keyFile(dir) {
  return path.join(dir, FILE);
}

// The key only ever travels over HTTPS. Plain http is allowed for a loopback
// studio, which is a local test server and never the network.
function usableOrigin(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
  return null;
}

function store(dir, safeStorage, raw) {
  const key = String(raw || '').trim();
  const m = KEY_RE.exec(key);
  if (!m) throw new Error('That is not a G Studio owner key (gsok1.<id>.<secret>).');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available.');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${keyFile(dir)}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(key), { mode: 0o600 });
  fs.renameSync(tmp, keyFile(dir));
  return m[1];
}

function load(dir, safeStorage) {
  let buf;
  try {
    buf = fs.readFileSync(keyFile(dir));
  } catch {
    return null;
  }
  try {
    const key = safeStorage.decryptString(buf);
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

function remove(dir) {
  try {
    fs.unlinkSync(keyFile(dir));
    return true;
  } catch {
    return false;
  }
}

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      data += c;
      if (data.length > 4096) reject(new Error('Too much input.'));
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

async function withTimeout(p) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    clearTimeout(t);
  }
}

// Returns 'signed-in' (already had a session), 'renewed' (traded the key),
// or 'no-key' / 'bad-origin' / 'refused:<status>' / 'error'. Never throws and
// never includes the key or token in what it returns.
async function ensureSession({ ses, origin, key }) {
  const base = usableOrigin(origin);
  if (!base) return 'bad-origin';
  if (!key) return 'no-key';
  try {
    const me = await withTimeout(ses.fetch(`${base}/api/auth/me`, { credentials: 'include', cache: 'no-store' }));
    if (me.ok) return 'signed-in';
    if (me.status !== 401) return `refused:${me.status}`;
    const res = await withTimeout(ses.fetch(`${base}/api/app/owner-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GS': '1' },
      body: JSON.stringify({ key }),
      credentials: 'omit',
      cache: 'no-store',
    }));
    if (!res.ok) return `refused:${res.status}`;
    const body = await res.json();
    if (!body || typeof body.token !== 'string' || body.cookie_name !== COOKIE) return 'error';
    await ses.cookies.set({
      url: `${base}/`,
      name: COOKIE,
      value: body.token,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Number(body.expires_at) || undefined,
    });
    await ses.cookies.flushStore();
    return 'renewed';
  } catch {
    return 'error';
  }
}

module.exports = { KEY_RE, keyFile, usableOrigin, store, load, remove, readStdin, ensureSession };
