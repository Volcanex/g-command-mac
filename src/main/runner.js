'use strict';

// Runner mode: this Mac takes g-engine device-test jobs. Replaces ~/mac-runner.sh
// (a Chrome of its own on the runner page plus `caffeinate -dimsu`).
//
// The page lives in its own hidden BrowserWindow, never the main window, so
// closing the main window does not stop it. backgroundThrottling:false keeps
// its timers running and, per Electron, keeps document.visibilityState
// 'visible' while hidden, which the runner page needs before it takes a job.
// It has its own session partition, so no cookie crosses from g-command-web.
// A crash or failed load reloads it after RESTART_MS, like the script's loop.

const RUNNER_ORIGIN = 'https://newcastlev2.gabrielpenman.com';
const RUNNER_PATH = '/v2/tests/run/';
const PARTITION = 'persist:runner';
const RESTART_MS = 5000;

function runnerUrl(device) {
  const u = new URL(RUNNER_PATH, RUNNER_ORIGIN);
  u.searchParams.set('device', device);
  return u.toString();
}

// Device names the page and job API accept: keep it to a plain slug.
function cleanDevice(d, fallback = 'gabriel-main') {
  const s = String(d || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

class Runner {
  // electron: { BrowserWindow, powerSaveBlocker }; onChange: called with status().
  constructor(electron, onChange = () => {}) {
    this.e = electron;
    this.onChange = onChange;
    this.win = null;
    this.blockers = [];
    this.timer = null;
    this.device = 'gabriel-main';
    this.state = 'off'; // off | loading | up | restarting
    this.lastLoad = null;
    this.lastCrash = null;
    this.lastError = '';
  }

  status() {
    return {
      on: this.state !== 'off',
      state: this.state,
      device: this.device,
      url: runnerUrl(this.device),
      lastLoad: this.lastLoad,
      lastCrash: this.lastCrash,
      lastError: this.lastError,
    };
  }

  set(state) {
    this.state = state;
    this.onChange(this.status());
  }

  start(device) {
    this.device = cleanDevice(device);
    if (!this.blockers.length) {
      // caffeinate -dimsu as far as Electron goes: display sleep is the
      // stronger blocker (it also holds the system awake); app suspension
      // keeps App Nap off this process.
      this.blockers = [
        this.e.powerSaveBlocker.start('prevent-display-sleep'),
        this.e.powerSaveBlocker.start('prevent-app-suspension'),
      ];
    }
    this.open();
  }

  open() {
    clearTimeout(this.timer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    const win = new this.e.BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      title: `Runner ${this.device}`,
      webPreferences: {
        partition: PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win = win;
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('did-finish-load', () => {
      this.lastLoad = Date.now();
      this.lastError = '';
      this.set('up');
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
      if (isMain) this.restart(`Load failed: ${desc || code}`);
    });
    wc.on('render-process-gone', (_e, d) => this.restart(`Page stopped: ${d.reason}`));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      if (this.state !== 'off') this.restart('Window closed');
    });
    this.set('loading');
    win.loadURL(runnerUrl(this.device)).catch(() => {});
  }

  restart(reason) {
    if (this.state === 'off') return;
    this.lastCrash = Date.now();
    this.lastError = reason;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.state !== 'off' && this.open(), RESTART_MS);
    this.set('restarting');
  }

  stop() {
    this.state = 'off';
    clearTimeout(this.timer);
    for (const id of this.blockers) {
      try { this.e.powerSaveBlocker.stop(id); } catch {}
    }
    this.blockers = [];
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
    this.onChange(this.status());
  }

  // Test hook: what the page itself reports.
  probe() {
    if (!this.win || this.win.isDestroyed()) return Promise.resolve(null);
    return this.win.webContents.executeJavaScript(
      "({visibility: document.visibilityState, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 400)})",
    ).catch(() => null);
  }
}

module.exports = { Runner, runnerUrl, cleanDevice, RUNNER_ORIGIN, PARTITION, RESTART_MS };
