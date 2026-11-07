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

// The Mac page's genv buttons, built from `genv status --json`. Rule from
// genv-bar: each label names what clicking DOES (the destination), never the
// current state; the state goes in `detail`. `args` is the genv verb run as is.
function actions(st) {
  const s = st || {};
  const procs = s.processes || {};
  const wmUp = procs.aerospace === 'up';
  const devices = (s.sidecar && s.sidecar.devices) || [];
  const docked = devices.some((d) => d.connected);
  const chromeOn = String(s.chrome || 'off').startsWith('on');
  const out = [];
  out.push(wmUp
    ? { id: 'down', label: 'Stop genv', detail: 'Running now', args: ['down'] }
    : { id: 'up', label: 'Start genv', detail: 'Stopped now', args: ['up'] });
  out.push(docked
    ? { id: 'ipad', label: 'Disconnect the iPad', detail: `${s.sidecar.connected || 'iPad'} connected now`, args: ['ipad', 'toggle'] }
    : { id: 'ipad', label: 'Connect the iPad', detail: devices.length ? 'Not connected now' : 'No iPad paired', args: ['ipad', 'toggle'] });
  const side = s.ipad_side === 'left' ? 'left' : 'right';
  out.push({ id: 'side', label: `Move the iPad to the ${side === 'left' ? 'right' : 'left'}`, detail: `On the ${side} now`, args: ['ipad', 'side', 'toggle'], enabled: docked, why: 'Needs the iPad connected' });
  const termMac = s.term_home !== 'secondary';
  out.push({ id: 'term', label: termMac ? 'Home the terminal on the iPad' : 'Home the terminal on the Mac', detail: `On the ${termMac ? 'Mac' : 'iPad'} now`, args: ['term', 'toggle'], enabled: docked, why: 'Needs a second display' });
  out.push({ id: 'tiling', label: s.tiling === 'on' ? 'Turn tiling off' : 'Turn tiling on', detail: `Tiling ${s.tiling === 'on' ? 'on' : 'off'} now`, args: ['tiling', 'toggle'], enabled: wmUp, why: 'Needs genv running' });
  out.push({ id: 'chrome', label: chromeOn ? 'Turn Chrome harmony off' : 'Turn Chrome harmony on', detail: chromeOn ? `On now (${String(s.chrome).replace(/^on[:,]?\s*/, '') || 'active'})` : 'Off now', args: ['chrome', 'toggle'] });
  out.push({ id: 'fade', label: 'Restart the switch fade', detail: `ae-fade ${procs['ae-fade'] === 'up' ? 'up' : 'down'} now`, args: ['fade', 'restart'] });
  // Sticky apps: the windows that follow every workspace switch, leftmost first.
  // `genv sticky` owns the list (~/.genv-sticky); the terminal is never one.
  const sticky = Array.isArray(s.sticky) ? s.sticky : [];
  sticky.forEach((app, i) => {
    out.push({ id: `unstick:${app}`, group: 'sticky', label: `Stop ${app} following you`, detail: `Sticky, ${i === 0 ? 'leftmost' : `slot ${i + 1}`}`, args: ['sticky', 'remove', app] });
    if (i > 0) out.push({ id: `left:${app}`, group: 'sticky', label: `Move ${app} one slot left`, detail: `Slot ${i + 1} now`, args: ['sticky', 'left', app] });
  });
  const skip = new Set(['Ghostty', 'Electron', ...sticky]);
  for (const app of (Array.isArray(s.running_apps) ? s.running_apps : []).filter((a) => !skip.has(a))) {
    out.push({ id: `stick:${app}`, group: 'sticky', label: `Make ${app} follow you`, detail: 'Stays on its own workspace now', args: ['sticky', 'add', app] });
  }
  for (const a of out) if (a.enabled === undefined) a.enabled = true;
  return out;
}

// The Mac page may only ask for verbs it was shown.
function allowed(st, args) {
  const want = JSON.stringify(args);
  return actions(st).some((a) => a.enabled && JSON.stringify(a.args) === want);
}

module.exports = { locate, status, run, summarise, actions, allowed, candidates, STATUS_ARGS };
