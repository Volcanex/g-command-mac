'use strict';

// Headless smoke test: runs the app (the packaged Linux build when it exists,
// otherwise the dev tree) under xvfb against a throwaway userData directory and
// a random ntfy.sh topic, publishes one alert to that topic, and checks the app
// received it, routed it, and wrote both screenshots.
//
//   node scripts/smoke.js [screenshot-dir]
//
// GCM_LOGIN_PASSWORD, if set, signs the test session in so the tickets feed is
// exercised; the docs screenshots are taken with GCM_REDACT=1 regardless.
// GCM_SMOKE_SERVER and GCM_SMOKE_BRAIN_API point the run at a real g-command-web
// and g-brain API. Without them it uses the config defaults, which expect both
// on this machine.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const shots = path.resolve(process.argv[2] || path.join(root, 'docs-screens'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gcm-smoke-'));
const topic = `gcm-smoke-${crypto.randomBytes(9).toString('hex')}`;
const config = { ntfy: { server: 'https://ntfy.sh', topics: [topic] } };
if (process.env.GCM_SMOKE_SERVER) config.servers = [{ id: 'central', name: 'Central', url: process.env.GCM_SMOKE_SERVER, central: true }];
if (process.env.GCM_SMOKE_BRAIN_API) config.brainApi = process.env.GCM_SMOKE_BRAIN_API;
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config));

const packaged = path.join(root, 'dist', 'linux-unpacked', 'g-command');
const bin = fs.existsSync(packaged) ? [packaged] : [path.join(root, 'node_modules', '.bin', 'electron'), root];
const args = ['-a', '-s', '-screen 0 1440x900x24', ...bin, '--no-sandbox'];
const env = {
  ...process.env,
  GCM_USER_DATA: userData,
  GCM_SCREENSHOTS: shots,
  GCM_REDACT: '1',
  GCM_DEBUG: '1',
  GCM_SHOT_THEME: 'light',
  GCM_SMOKE_WAIT_MS: '8000',
};

console.log(`running ${fs.existsSync(packaged) ? 'packaged build' : 'dev tree'}`);
const child = spawn('xvfb-run', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const seen = { live: false, notified: null, done: null };
let published = false;

child.stdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.ntfy === 'live' && !published) {
      published = true;
      seen.live = true;
      fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: 'Smoke test body', headers: { Title: 'Reminder' } });
    }
    if (o.notified) seen.notified = o;
    if (o.screenshots) seen.done = o;
  }
});

const kill = setTimeout(() => child.kill('SIGTERM'), 120000);
child.on('exit', () => {
  clearTimeout(kill);
  fs.rmSync(userData, { recursive: true, force: true });
  const files = ['main-window.png', 'tray-panel.png', 'tray-panel-light.png'].filter((f) => fs.existsSync(path.join(shots, f)));
  const result = {
    ntfyLive: seen.live,
    notified: seen.notified,
    snapshot: seen.done && seen.done.snapshot,
    consoleErrors: seen.done && seen.done.consoleErrors,
    screenshots: files.map((f) => path.join(shots, f)),
  };
  console.log(JSON.stringify(result, null, 2));
  const ok = seen.live && seen.notified && seen.notified.target.endsWith('/calendar') && files.length === 3;
  process.exit(ok ? 0 : 1);
});
