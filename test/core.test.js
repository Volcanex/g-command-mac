'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Config, DEFAULTS, normalise } = require('../src/main/config');
const { route } = require('../src/main/routes');
const { NtfySubscriber, parseLine, buildUrl } = require('../src/main/ntfy');
const genvMac = require('../src/main/genv-mac');
const status = require('../src/main/status');

function tmpConfig(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcm-'));
  if (data) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(data));
  const c = new Config(dir);
  c.load();
  return c;
}

test('defaults write a private config file', () => {
  const c = tmpConfig();
  assert.strictEqual(c.data.servers.length, 1);
  assert.strictEqual(c.activeServer.url, DEFAULTS.servers[0].url);
  assert.strictEqual(fs.statSync(c.file).mode & 0o777, 0o600);
});

test('servers are cleaned, deduped and one is central', () => {
  const c = normalise({
    servers: [
      { name: 'Box', url: 'https://box.example/some/path' },
      { name: 'Box', url: 'https://other.example' },
      { name: 'Bad', url: 'ftp://nope' },
    ],
    ntfy: { topics: 'a, b' },
  });
  assert.deepStrictEqual(c.servers.map((s) => s.id), ['box', 'box-2']);
  assert.strictEqual(c.servers[0].url, 'https://box.example');
  assert.strictEqual(c.servers[0].central, true);
  assert.strictEqual(c.activeServer, 'box');
  assert.deepStrictEqual(c.ntfy.topics, ['a', 'b']);
});

test('a broken config is moved aside, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcm-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  new Config(dir).load();
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.broken-')));
});

test('routing prefers click, then rules, then defaults', () => {
  const c = tmpConfig({ routes: [{ title: '^deploy', path: '/crons' }] });
  const base = DEFAULTS.servers[0].url;
  assert.strictEqual(route({ title: 'x', click: `${base}/tickets` }, c).url, `${base}/tickets`);
  assert.deepStrictEqual(route({ title: 'x', click: 'https://elsewhere.example/a' }, c), {
    kind: 'external',
    url: 'https://elsewhere.example/a',
  });
  assert.strictEqual(route({ title: 'Deploy finished' }, c).url, `${base}/crons`);
  assert.strictEqual(route({ title: 'Vital reminder' }, c).url, `${base}/calendar`);
  assert.strictEqual(route({ title: 'Catching up (3)' }, c).url, `${base}/calendar`);
  assert.strictEqual(route({ title: 'openrouter', tags: ['warning'] }, c).url, `${base}/system`);
  assert.strictEqual(route({ title: 'hello' }, c).url, `${base}/`);
});

test('ntfy lines parse and messages are deduped', () => {
  assert.strictEqual(parseLine(''), null);
  assert.strictEqual(parseLine('garbage'), null);
  assert.strictEqual(buildUrl('https://ntfy.sh', ['a', 'b c'], 'xyz'), 'https://ntfy.sh/a,b%20c/json?since=xyz');
  const sub = new NtfySubscriber({});
  const got = [];
  sub.on('message', (m) => got.push(m));
  sub.handle(parseLine('{"id":"1","event":"open"}'));
  sub.handle(parseLine('{"id":"2","event":"message","title":"Reminder","message":"hi","time":1}'));
  sub.handle(parseLine('{"id":"2","event":"message","title":"Reminder","message":"hi","time":1}'));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].title, 'Reminder');
  assert.strictEqual(sub.state.lastId, '2');
});

test('ntfy stream is read and reconnects after it closes', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    calls += 1;
    assert.match(url, /\/topic\/json/);
    assert.strictEqual(opts.headers.Authorization, 'Bearer tok');
    const body = (async function* () {
      yield new TextEncoder().encode('{"event":"open"}\n{"id":"a","event":"message","title":"T","mes');
      yield new TextEncoder().encode('sage":"M"}\n');
    })();
    return { ok: true, status: 200, body };
  };
  const sub = new NtfySubscriber({ fetchImpl });
  const got = [];
  sub.on('message', (m) => got.push(m));
  const statuses = [];
  sub.on('status', (s) => statuses.push(s.status));
  sub.start({ server: 'https://ntfy.example', topics: ['topic'], token: 'tok' });
  await new Promise((r) => setTimeout(r, 50));
  sub.stop();
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].message, 'M');
  assert.ok(statuses.includes('live') && statuses.includes('retrying'));
  assert.strictEqual(calls, 1);
});

test('g-env-mac degrades when absent and reads a checkout when present', async () => {
  const absent = await genvMac.status({ genvMac: { path: '/nonexistent' } });
  if (!genvMac.locate({ genvMac: { path: '/nonexistent' } })) assert.strictEqual(absent.available, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genv-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'genv'), '#!/bin/sh\nprintf "\\033[1mg-system\\033[0m  all up\\nmore\\n"\n', { mode: 0o755 });
  const s = await genvMac.status({ genvMac: { path: dir } });
  assert.deepStrictEqual([s.available, s.ok, s.summary], [true, true, 'g-system  all up']);
});

test('health lists failing services and probed dependencies only', async () => {
  const body = {
    summary: { up: 1, down: 1, total: 2 },
    dep_summary: { up: 1, warn: 1, unknown: 1, total: 3 },
    services: [{ id: 'a', state: 'up' }, { id: 'b', state: 'down' }],
    dependencies: [
      { id: 'x', kind: 'dependency', state: 'up' },
      { id: 'y', kind: 'dependency', state: 'warn' },
      { id: 'z', kind: 'dependency', state: 'unknown' },
    ],
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
  const h = await status.health(fetchImpl, 'https://brain.example.com');
  assert.deepStrictEqual(h.issues.map((i) => i.id), ['b', 'y']);
  assert.strictEqual(h.level, 'down');
});

// ---------------------------------------------------------------- studio owner key

const studioKey = require('../src/main/studio-key');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};
const GOOD = `gsok1.${'a'.repeat(11)}.${'b'.repeat(43)}`;

test('owner key is stored encrypted, 0600, and only if well formed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcm-key-'));
  assert.throws(() => studioKey.store(dir, fakeSafe, 'nope'));
  assert.strictEqual(studioKey.store(dir, fakeSafe, `${GOOD}\n`), 'a'.repeat(11));
  assert.strictEqual(fs.statSync(studioKey.keyFile(dir)).mode & 0o777, 0o600);
  assert.strictEqual(studioKey.load(dir, fakeSafe), GOOD);
  assert.ok(studioKey.remove(dir));
  assert.strictEqual(studioKey.load(dir, fakeSafe), null);
});

test('owner key only goes to https or a loopback test studio', () => {
  assert.strictEqual(studioKey.usableOrigin('https://studio.example.com/x'), 'https://studio.example.com');
  assert.strictEqual(studioKey.usableOrigin('http://127.0.0.1:9'), 'http://127.0.0.1:9');
  assert.strictEqual(studioKey.usableOrigin('http://studio.example.com'), null);
  assert.strictEqual(studioKey.usableOrigin('garbage'), null);
});

test('ensureSession trades the key only when the studio says signed out', async () => {
  const calls = [];
  const jar = [];
  const ses = {
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.endsWith('/api/auth/me')) return { ok: jar.length > 0, status: jar.length ? 200 : 401 };
      return { ok: true, status: 200, json: async () => ({ token: 't0k', cookie_name: '__Host-gs_session', expires_at: 2e9 }) };
    },
    cookies: { set: async (c) => jar.push(c), flushStore: async () => {} },
  };
  const origin = 'https://studio.example.com';
  assert.strictEqual(await studioKey.ensureSession({ ses, origin, key: null }), 'no-key');
  assert.strictEqual(await studioKey.ensureSession({ ses, origin: 'http://evil.example', key: GOOD }), 'bad-origin');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(await studioKey.ensureSession({ ses, origin, key: GOOD }), 'renewed');
  assert.deepStrictEqual(JSON.parse(calls[1].opts.body), { key: GOOD });
  assert.strictEqual(calls[1].opts.headers['X-GS'], '1');
  assert.strictEqual(jar[0].name, '__Host-gs_session');
  assert.ok(jar[0].secure && jar[0].httpOnly);
  assert.strictEqual(await studioKey.ensureSession({ ses, origin, key: GOOD }), 'signed-in');
  assert.strictEqual(calls.length, 3);
});
