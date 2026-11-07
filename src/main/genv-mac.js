'use strict';

// Local link to the Mac's genv checkout (the one ~/.local/bin/genv runs from).
//
// The contract this app relies on is deliberately small:
//   locate(config)  -> absolute path of a g-env-mac checkout, or null
//   status(config)  -> { available, path?, ok?, summary?, output?, reason? }
//
// status() runs the checkout's own CLI, `bin/genv status`, which is the verb
// genv-bar already shells out to, so the app and the menu bar cannot drift.
// That verb prints a rich panel, not JSON, so for now the app shows its first
// line and keeps the full text for a tooltip. The Mac agent should confirm the
// verb on a real checkout and, ideally, add `genv status --json` to g-env-mac
// and switch STATUS_ARGS to it. Everything degrades to { available: false }
// when no checkout is found, which is the normal case on Linux.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const STATUS_ARGS = ['status', '--json'];
const TIMEOUT_MS = 8000;

function candidates(config) {
  const home = os.homedir();
  return [
    config && config.genvMac && config.genvMac.path,
    process.env.G_ENV_MAC_DIR,
    // The live checkout: ~/.local/bin/genv and the AeroSpace config link here.
    path.join(home, 'genv'),
    path.join(home, 'g-env-mac'),
    path.join(home, 'genv-mac'),
    path.join(home, 'Desktop', 'g-env-mac'),
    path.join(home, 'Desktop', 'genv-mac'),
  ].filter(Boolean);
}

function locate(config) {
  for (const dir of candidates(config)) {
    try {
      if (fs.statSync(path.join(dir, 'bin', 'genv')).isFile()) return dir;
    } catch {}
  }
  return null;
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

function genvEnv() {
  // Apps launched from Finder get a bare PATH; bin/genv's shebang wants
  // Homebrew's python3.12.
  return {
    ...process.env,
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'),
    NO_COLOR: '1',
    COLUMNS: '100',
  };
}

// One line a person reads, from the JSON state.
function summarise(st) {
  const procs = Object.entries(st.processes || {});
  const down = procs.filter(([, v]) => v !== 'up').map(([k]) => k);
  const head = !procs.length ? 'genv' : down.length ? `genv: ${down.join(', ')} down` : 'genv all up';
  const pad = st.sidecar && st.sidecar.connected ? `, ${st.sidecar.connected} connected` : '';
  return head + pad;
}

function status(config) {
  const dir = locate(config);
  if (!dir) return Promise.resolve({ available: false, reason: 'No genv checkout found' });
  return new Promise((resolve) => {
    execFile(path.join(dir, 'bin', 'genv'), STATUS_ARGS, { cwd: dir, env: genvEnv(), timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      const output = stripAnsi(stdout || stderr).trim();
      let state = null;
      try { state = JSON.parse(output); } catch {}
      // An older checkout without --json prints the rich panel: keep its first line.
      const summary = state ? summarise(state)
        : output.split('\n').map((l) => l.trim()).find(Boolean) || '';
      resolve({
        available: true,
        path: dir,
        ok: !err,
        summary: err && !summary ? 'genv status did not answer' : summary,
        output,
        state,
      });
    });
  });
}

// Run a genv verb (e.g. ['ipad', 'toggle']). The app never reimplements one:
// genv is the single implementation, the app is a button for it.
function run(config, args) {
  const dir = locate(config);
  if (!dir) return Promise.resolve({ ok: false, output: 'No genv checkout found' });
  return new Promise((resolve) => {
    execFile(path.join(dir, 'bin', 'genv'), args, { cwd: dir, env: genvEnv(), timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: stripAnsi(stdout || stderr).trim() });
    });
  });
}

module.exports = { locate, status, run, summarise, candidates, STATUS_ARGS };
