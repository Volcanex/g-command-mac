'use strict';

// Local link to g-env-mac (GitHub Volcanex/g-env-mac). STUB.
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

const STATUS_ARGS = ['status'];
const TIMEOUT_MS = 8000;

function candidates(config) {
  const home = os.homedir();
  return [
    config && config.genvMac && config.genvMac.path,
    process.env.G_ENV_MAC_DIR,
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

function status(config) {
  const dir = locate(config);
  if (!dir) return Promise.resolve({ available: false, reason: 'No g-env-mac checkout found' });
  // Apps launched from Finder get a bare PATH; bin/genv's shebang wants
  // Homebrew's python3.12.
  const env = {
    ...process.env,
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'),
    NO_COLOR: '1',
    COLUMNS: '100',
  };
  return new Promise((resolve) => {
    execFile(path.join(dir, 'bin', 'genv'), STATUS_ARGS, { cwd: dir, env, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      const output = stripAnsi(stdout || stderr).trim();
      const summary = output.split('\n').map((l) => l.trim()).find(Boolean) || '';
      resolve({
        available: true,
        path: dir,
        ok: !err,
        summary: err && !summary ? 'genv status did not answer' : summary,
        output,
      });
    });
  });
}

module.exports = { locate, status, candidates, STATUS_ARGS };
