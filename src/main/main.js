'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  Notification,
  ipcMain,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  WebContentsView,
} = require('electron');

const { Config, partitionFor } = require('./config');
const { NtfySubscriber } = require('./ntfy');
const { route } = require('./routes');
const genvMac = require('./genv-mac');
const { Runner } = require('./runner');
const studioKey = require('./studio-key');
const { MAC_PATH, isMacUrl, clampRect } = require('./mac-page');

const isMac = process.platform === 'darwin';
const SHOTS = process.env.GCM_SCREENSHOTS || '';
const DEBUG = process.env.GCM_DEBUG === '1';
const debug = (o) => DEBUG && console.log(JSON.stringify(o));

// GCM_USER_DATA isolates a test run from the real profile; it must be set
// before anything reads userData.
// The settings folder keeps the lowercase name every install already has,
// so renaming the app for display never strands config.json or the sign-in.
app.setPath('userData', process.env.GCM_USER_DATA || path.join(app.getPath('appData'), 'g-command'));
app.setName('G-Command');

const config = new Config(app.getPath('userData'));
const ntfy = new NtfySubscriber({ stateDir: app.getPath('userData') });

let macView = null; // the Mac page, laid over the active view's content area
let quitting = false;
let pollTimer = null;
let statusAt = null;
let ntfyStatus = { status: 'off', detail: '' };
let genvStatus = { available: false, reason: 'Not checked yet' };
let genvBusy = null; // id of the genv action running now
// Runner mode lives in its own hidden window (runner.js), not the main one.
const runner = new Runner({ BrowserWindow, powerSaveBlocker }, () => pushState());

// Cmd+1..9 map to the web's own sidebar pages, in its order.
const PAGES = [
  { label: 'Home', path: '/' },
  { label: 'Studio', path: '/studio' },
  { label: 'Chat', path: '/chat' },
  { label: 'Calendar', path: '/calendar' },
  { label: 'Pulse', path: '/pulse' },
  { label: 'Services', path: '/system' },
  { label: 'Compute', path: '/compute' },
  { label: 'Tickets', path: '/tickets' },
  { label: 'Projects', path: '/projects' },
].map((p, i) => ({ ...p, accel: `CmdOrCtrl+${i + 1}` }));

const BG = '#111113';
// A hidden warm page older than this is reloaded in the background, so a
// swap never shows data more than a minute and a half old.
const STALE_MS = 90 * 1000;
const timing = (event) => process.env.GCM_TIMING && console.log(JSON.stringify({ timing: event, at: Date.now() }));

// The web page owns the whole window. The traffic lights keep macOS's inset place (12px
// circles at y 12..24, centre 18). The rail's brand sits --sp-4 (16px) under them: its 16px
// mark at y 40..56 in a 32px row centred on y 48. The top bar comes down to that row: 66px tall,
// its last 36px a row centred on the same y 48, so the page title or crumbs, at the 13px of the
// nav labels, read on the brand's line (caps nudged 1px down, the first glyph's 1px side
// bearing taken back), with the content's top rule 18px under that line (y 66). The
// title starts exactly on the rail/content edge; over a collapsed rail it moves, easing with the
// rail, to where page content starts (the content's 1px rule plus --gutter), the same on every
// page. The brand row is one 32px nav row: a 16px mark
// and 14px wordmark on the nav items' icon and label columns, and a
// 24px collapse button whose icon sits 8px in from the items' right edge as the icons sit from
// their left. The content area carries the only vertical rule, rounded at its top-left corner,
// in every rail state and every frame of the rail's animation, so the rail's own border is never
// drawn. The current crumb is grey like its parents. Only the nav list scrolls, so the rail's
// scrollbar starts under the brand row and never crosses the lights' corner. Studio's own shell, mounted in /studio, gets the same; the Command shell round it has
// no top bar there, so it keeps the plain rail line.
const INSET_CSS = `
aside:has(> .brand-row) { -webkit-app-region: drag; }
aside:has(> .brand-row) > * { -webkit-app-region: no-drag; }
header.topbar { -webkit-app-region: drag; }
header.topbar a, header.topbar button, header.topbar input, header.topbar select,
header.topbar [role="button"], header.topbar [tabindex] { -webkit-app-region: no-drag; }
body .g-shell > aside > .brand-row, body.g-shell > aside > .brand-row {
  -webkit-app-region: drag; padding-top: calc(24px + var(--sp-4) - var(--sp-2)) !important; margin-bottom: var(--sp-2);
}
.g-shell > aside > .brand-row > * { -webkit-app-region: no-drag; }
.g-shell > aside > .brand-row > .brand { padding: 0 var(--sp-2); min-height: var(--h-3); gap: var(--sp-2); }
.g-shell > aside > .brand-row > .brand .g-mark { width: 16px; height: 16px; }
.g-shell > aside > .brand-row > .brand b { font-size: 14px; line-height: var(--lh-2); }
.g-shell > aside > .brand-row > .g-rail-toggle { width: var(--h-1); height: var(--h-1); margin: 0 var(--sp-1) 0 0; }
.g-shell[data-rail="collapsed"]:not([data-rail-peek]) > aside:has(> .brand-row) {
  border-right-color: transparent !important;
  background-image: linear-gradient(var(--border), var(--border));
  background-origin: border-box;
  background-size: 1px calc(100% - 47px);
  background-position: right bottom;
  background-repeat: no-repeat;
}
.g-shell:not(body.studio-page) > aside:has(> .brand-row) {
  border-right-color: transparent !important;
  background-image: none !important;
}
.g-shell:not(body.studio-page):has(> aside > .brand-row) > main { background: var(--surface-1); }
.g-shell:not(body.studio-page):has(> aside > .brand-row) > main > header.topbar { border-bottom-color: transparent; }
.g-shell:not(body.studio-page):has(> aside > .brand-row) > main > :is(.content, .g-status) {
  background: var(--bg); border-left: 1px solid var(--border);
}
.g-shell:not(body.studio-page):has(> aside > .brand-row) > main > .content {
  border-top: 1px solid var(--border-subtle); border-top-left-radius: var(--radius-card, 12px);
}
header.topbar :is(.topbar-crumbs, .topbar-title, .page-title) { font-size: 13px; }
header.topbar :is(.topbar-title, .page-title) { color: var(--text-secondary); }
@media (min-width: 721px) {
  body .g-shell > aside:has(> .brand-row > .brand), body.g-shell > aside:has(> .brand-row > .brand) { overflow: hidden; }
  .g-shell > aside > .brand-row ~ .nav-list {
    flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    width: calc(var(--rail-w) - var(--sp-3)); margin-right: calc(-1 * var(--sp-3)); padding-right: var(--sp-3);
  }
}
body.g-shell > main > header.topbar, .studio-host .g-shell > main > header.topbar {
  box-sizing: border-box; min-height: 66px; height: 66px; padding-block: 30px 0; padding-left: 0;
  transition: padding-left var(--spring-smooth-dur) var(--spring-smooth);
}
body.g-shell[data-rail="collapsed"]:not([data-rail-peek]) > main > header.topbar,
.studio-host .g-shell[data-rail="collapsed"]:not([data-rail-peek]) > main > header.topbar { padding-left: calc(1px + var(--gutter)); }
body.g-shell > main > header.topbar > :is(.topbar-crumbs, .topbar-title, .page-title),
.studio-host .g-shell > main > header.topbar > :is(.topbar-crumbs, .topbar-title, .page-title) {
  position: relative; top: 1px; margin-left: -1px;
}
`;

// The web's rail reads its pinned/collapsed choice from localStorage once, at
// page load. Warm pages stay loaded for the whole session, so a choice made in
// one view never reached the others and a swap showed the old state. Mirror
// the storage event into each page's own shell so every view follows the last
// choice.
const RAIL_SYNC_JS = `
if (!window.__gcmRailSync) {
  window.__gcmRailSync = true;
  addEventListener('storage', (e) => {
    if (!e.key || !/^g-rail-[^.]*$/.test(e.key) || e.key.includes('group') || !e.newValue) return;
    const shell = document.querySelector('body > .g-shell, .g-shell');
    if (!shell) return;
    const collapsed = e.newValue === 'collapsed';
    shell.setAttribute('data-rail', collapsed ? 'collapsed' : e.newValue);
    shell.removeAttribute('data-rail-peek');
    shell.querySelectorAll(':scope > aside .g-rail-toggle').forEach((b) => {
      const label = collapsed ? 'Keep open' : 'Collapse';
      b.setAttribute('aria-label', label);
      b.setAttribute('data-tip', label);
      b.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    });
  });
}`;

// The Mac page: what this device runs (genv, sticky apps, runner mode, alerts).
// It is not a web page, so the app adds its rail item to the web's own nav
// list, styled by the web's .nav-item, and draws the page itself in a local
// view laid over the content area. The item navigates to MAC_PATH with the
// content area's rect; will-navigate catches that, so the web page needs no
// bridge and no IPC of its own. A rail resize re-sends the rect.
const MAC_NAV_JS = `
if (!window.__gcmMac) {
  const state = { open: false, prev: [], crumb: null };
  const crumbs = () => document.querySelector('header.topbar > :is(.topbar-crumbs, .topbar-title, .page-title)');
  const content = () => document.querySelector('.g-shell > main > .content, .g-shell main > .content');
  const list = () => document.querySelector('.g-shell > aside .nav-list');
  const go = () => {
    const c = content();
    if (!c) return;
    const r = c.getBoundingClientRect();
    const q = new URLSearchParams({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    location.assign('${MAC_PATH}?' + q);
  };
  const mark = (on) => {
    const l = list();
    const item = l && l.querySelector('.nav-item[data-gcm-mac]');
    if (!item) return;
    if (on) {
      if (!state.prev.length) state.prev = [...l.querySelectorAll('.nav-item[aria-current]')].filter((n) => n !== item);
      state.prev.forEach((n) => { n.dataset.gcmCurrent = n.getAttribute('aria-current'); n.removeAttribute('aria-current'); });
      item.setAttribute('aria-current', 'page');
      item.scrollIntoView({ block: 'nearest' });
      const c = crumbs();
      if (c && !state.crumb) { state.crumb = c.cloneNode(true); c.replaceChildren('Mac'); }
    } else {
      item.removeAttribute('aria-current');
      state.prev.forEach((n) => n.setAttribute('aria-current', n.dataset.gcmCurrent || 'page'));
      state.prev = [];
      const c = crumbs();
      if (c && state.crumb) c.replaceChildren(...state.crumb.childNodes);
      state.crumb = null;
    }
  };
  const add = () => {
    const l = list();
    if (!l || l.querySelector('[data-gcm-mac]')) return;
    const a = document.createElement('a');
    a.className = 'nav-item';
    a.href = '${MAC_PATH}';
    a.dataset.gcmMac = '';
    a.innerHTML = '<i class="ph ph-laptop" aria-hidden="true"></i><span class="ellipsis">Mac</span>';
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); go(); }, true);
    l.append(a);
    if (state.open) mark(true);
  };
  let t = 0;
  const later = () => { clearTimeout(t); t = setTimeout(() => { add(); if (state.open) go(); }, 120); };
  add();
  new MutationObserver(() => { if (!list() || !list().querySelector('[data-gcm-mac]')) add(); })
    .observe(document.body, { childList: true, subtree: true });
  new ResizeObserver(() => state.open && later()).observe(document.documentElement);
  const c = content();
  if (c) new ResizeObserver(() => state.open && later()).observe(c);
  window.__gcmMac = { open: go, set: (on) => { state.open = on; mark(on); } };
}`;

function macRect(url) {
  return clampRect(url, main.win.getContentBounds());
}

function loadMac() {
  macView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'mac.html'), {
    query: { command: config.centralServer.url },
  });
}

function ensureMacView() {
  if (macView && !macView.webContents.isDestroyed()) return macView;
  macView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'mac.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Transparent, so the web's rounded content corner shows through.
  macView.setBackgroundColor('#00000000');
  macView.setVisible(false);
  macView.openFor = null;
  hardenContents(macView.webContents);
  loadMac();
  return macView;
}

function showMac(rect) {
  const v = ensureMacView();
  // Re-adding raises it above any warm view added since.
  main.win.contentView.addChildView(v);
  // Inset 1px past the web's content rule so the line stays the web's own.
  v.setBounds({ x: rect.x + 1, y: rect.y + 1, width: Math.max(1, rect.width - 1), height: Math.max(1, rect.height - 1) });
  v.setVisible(true);
  if (v.openFor !== main.active) {
    v.openFor = main.active;
    const wc = activeContents();
    if (wc) wc.executeJavaScript('window.__gcmMac && window.__gcmMac.set(true)').catch(() => {});
    v.webContents.focus();
    refresh();
  }
  main.win.setTitle('Mac');
}

function hideMac() {
  if (!macView || !macView.openFor) return;
  const view = main && main.views.get(macView.openFor);
  macView.openFor = null;
  macView.setVisible(false);
  if (view) view.webContents.executeJavaScript('window.__gcmMac && window.__gcmMac.set(false)').catch(() => {});
  if (main) updateTitle();
}

function openMac() {
  const m = showMain();
  const wc = activeContents();
  if (!wc) return;
  // A page without the rail (sign-in, offline) gets the whole window.
  wc.executeJavaScript('window.__gcmMac && document.querySelector(".g-shell > aside .nav-list") ? (window.__gcmMac.open(), true) : false')
    .then((ok) => {
      if (ok) return;
      const { width, height } = m.win.getContentBounds();
      showMac({ x: 0, y: TOPBAR_H, width, height: height - TOPBAR_H });
    })
    .catch(() => {});
}

// The top bar's height as INSET_CSS sets it, so the no-rail fallback follows it.
const TOPBAR_H = Number((/body\.g-shell > main > header\.topbar[^{]*\{[^}]*?[;\s]height:\s*(\d+)px/.exec(INSET_CSS) || [])[1]) || 36;

function isOwnUrl(url) {
  return !!config.serverForUrl(url) || config.isAuthUrl(url);
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (config.serverForUrl(url)) {
      openUrl(url);
    } else if (/^(https?|mailto):/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isOwnUrl(url)) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- main window
//
// One BaseWindow holds a small pool of WebContentsViews, one per warm page.
// Only the active view is visible; the rest sit loaded behind it. A link to a
// warm page swaps views instead of loading, and every other link navigates
// the active view exactly as a browser tab would.

let main = null; // { win, server, views: Map<key, view>, active: key, trail: [{ key, url }] }
let saveTimer = null;
let refreshTimer = null;

function warmKey(server, url) {
  try {
    const u = new URL(url);
    if (u.origin !== server.url || u.search || u.hash) return null;
    return config.data.warmPages.includes(u.pathname) ? u.pathname : null;
  } catch {
    return null;
  }
}

function homeUrl(key) {
  return new URL(key, main.server.url).toString();
}

function activeView() {
  return main && main.views.get(main.active);
}

function activeContents() {
  const v = activeView();
  return v ? v.webContents : null;
}

function fitView(view) {
  const { width, height } = main.win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
}

// Never reopen on a sign-in step or an error page: launching into a 404 or a
// spent auth link looks like the app is broken.
const NO_RESTORE = /^\/(signin|login|logout|auth|oauth)(\/|$)/;

function rememberUrl(url) {
  if (!config.serverForUrl(url)) return;
  try { if (NO_RESTORE.test(new URL(url).pathname)) return; } catch (e) { return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (config.data.lastUrl !== url) config.update({ lastUrl: url });
  }, 1000);
}

function createView(key, url) {
  const server = main.server;
  const view = new WebContentsView({
    webPreferences: {
      partition: partitionFor(server),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  view.setBackgroundColor(BG);
  view.setVisible(false);
  view.key = key;
  view.loadedAt = 0;
  const wc = view.webContents;
  hardenContents(wc);
  wc.on('will-navigate', (event, target) => {
    if (event.defaultPrevented) return;
    if (isMac && isMacUrl(server, target)) {
      event.preventDefault();
      if (main && main.active === view.key) showMac(macRect(target));
      return;
    }
    if (main && main.active === view.key) hideMac();
    const k = warmKey(server, target);
    if (k && k !== view.key && main.views.has(k)) {
      event.preventDefault();
      showView(k, target);
    }
  });
  wc.on('dom-ready', () => {
    if (isMac && config.serverForUrl(wc.getURL())) wc.insertCSS(INSET_CSS).catch(() => {});
    if (config.serverForUrl(wc.getURL())) wc.executeJavaScript(RAIL_SYNC_JS).catch(() => {});
    if (isMac && config.serverForUrl(wc.getURL())) wc.executeJavaScript(MAC_NAV_JS).catch(() => {});
  });
  wc.on('did-finish-load', () => {
    view.loadedAt = Date.now();
  });
  const onNav = (_e, navUrl, code) => {
    if (main && main.active === view.key) {
      hideMac();
      if (!(code >= 400)) rememberUrl(navUrl);
      updateTitle();
    }
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  wc.on('page-title-updated', () => main && main.active === view.key && updateTitle());
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    wc.loadFile(path.join(__dirname, '..', 'renderer', 'offline.html'), {
      query: { server: server.name, url: failedUrl, reason: desc, command: config.centralServer.url },
    });
  });
  main.win.contentView.addChildView(view);
  fitView(view);
  main.views.set(key, view);
  wc.loadURL(url);
  return view;
}

// A Mac window is titled by its document: the page name without the site
// suffix the web adds for browser tabs ("Calendar - Command").
function updateTitle() {
  if (macView && macView.openFor) return main.win.setTitle('Mac');
  const wc = activeContents();
  const title = wc ? wc.getTitle() : '';
  main.win.setTitle(title.replace(/\s+-\s+[^-]+$/, '') || 'G-Command');
}

function showView(key, url, { record = true } = {}) {
  const prev = activeView();
  const next = main.views.get(key);
  if (!next) return;
  if (prev !== next) hideMac();
  if (prev && prev !== next && record) main.trail.push({ key: prev.key, url: prev.webContents.getURL() });
  if (main.trail.length > 50) main.trail.shift();
  main.active = key;
  fitView(next);
  next.setVisible(true);
  if (prev && prev !== next) prev.setVisible(false);
  const wc = next.webContents;
  if (url && wc.getURL() !== url) wc.loadURL(url);
  if (main.win.isFocused()) wc.focus();
  rememberUrl(wc.getURL() || url);
  updateTitle();
  timing({ swap: key });
}

// Warm pages load one after another once the first page is up, so they
// never compete with it for the network on a cold launch.
async function warmPool() {
  for (const key of config.data.warmPages) {
    if (!main || main.views.has(key)) continue;
    const view = createView(key, homeUrl(key));
    await new Promise((r) => {
      view.webContents.once('did-stop-loading', r);
      setTimeout(r, 8000);
    });
  }
  timing({ warm: [...main.views.keys()] });
}

// Hidden warm pages drift (a link followed in them) or go stale; put them
// back on their page or reload them while nobody is looking.
function refreshHidden() {
  if (!main) return;
  const windowHidden = !main.win.isVisible();
  for (const view of main.views.values()) {
    const wc = view.webContents;
    if (wc.isLoading()) continue;
    const isActive = view.key === main.active;
    if (isActive && !windowHidden) continue;
    const onHome = wc.getURL() === homeUrl(view.key) || warmKey(main.server, wc.getURL()) === view.key;
    if (!view.key.startsWith('/')) continue;
    if (!onHome && !isActive) wc.loadURL(homeUrl(view.key));
    else if (onHome && Date.now() - view.loadedAt > STALE_MS) wc.reload();
  }
}

function createMain(server) {
  const win = new BaseWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'G-Command',
    backgroundColor: BG,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 10 },
  });
  const state = { win, server, views: new Map(), active: null, trail: [] };
  main = state;
  const last = config.data.lastUrl;
  const start = last && config.serverForUrl(last) && config.serverForUrl(last).id === server.id ? last : server.url;
  const key = warmKey(server, start) || 'first';
  const view = createView(key, start);
  showView(key, null, { record: false });
  // Show at once. The window's background is the page's own colour, so the
  // empty frame reads as the page arriving, and a page loading in a hidden
  // window is deprioritised by Chromium: waiting for dom-ready measured about
  // 200 ms slower to real content than showing straight away.
  timing({ shown: true });
  if (!SHOTS && !hiddenLaunch) win.show();
  // The pool starts only after the first page has settled: its renderers
  // starting earlier cost the first page about 200 ms of its own fetches.
  const wc0 = view.webContents;
  const startPool = () => setTimeout(warmPool, 1500);
  if (wc0.isLoading()) wc0.once('did-stop-loading', startPool);
  else startPool();
  win.on('resize', () => {
    const v = activeView();
    if (v) fitView(v);
  });
  win.on('focus', () => {
    const wc = activeContents();
    if (wc) wc.focus();
  });
  // Closing hides: the renderers stay alive, so reopening is instant.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (macView) {
      if (!macView.webContents.isDestroyed()) macView.webContents.close();
      macView = null;
    }
    for (const v of state.views.values()) v.webContents.close();
    if (main === state) main = null;
  });
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshHidden, 30 * 1000);
  return main;
}

// Each server has its own persistent partition, so signing in to one never
// leaks a cookie to another, and switching servers rebuilds the window.
function ensureMainWindow() {
  const server = config.activeServer;
  if (main && !main.win.isDestroyed() && main.server.id === server.id) return main;
  if (main && !main.win.isDestroyed()) {
    const old = main.win;
    quitting = true;
    old.close();
    quitting = false;
  }
  return createMain(server);
}

let hiddenLaunch = false;

function showMain() {
  const m = ensureMainWindow();
  if (!SHOTS) {
    hiddenLaunch = false;
    m.win.show();
    m.win.focus();
  }
  return m;
}

function openUrl(url) {
  const server = config.serverForUrl(url);
  if (server && server.id !== config.data.activeServer) {
    config.update({ activeServer: server.id });
    buildMenu();
  }
  const m = showMain();
  hideMac();
  const key = warmKey(m.server, url);
  if (key && m.views.has(key)) return showView(key, url);
  const wc = activeContents();
  if (wc && wc.getURL() !== url) wc.loadURL(url);
  timing({ navigate: url });
}

function openPage(p, serverId) {
  const server = config.data.servers.find((s) => s.id === serverId) || config.activeServer;
  openUrl(new URL(p, server.url).toString());
}

function goBack() {
  const wc = activeContents();
  if (!wc) return;
  if (wc.navigationHistory.canGoBack()) return wc.navigationHistory.goBack();
  const prev = main.trail.pop();
  if (prev && main.views.has(prev.key)) showView(prev.key, prev.url, { record: false });
}

function goForward() {
  const wc = activeContents();
  if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}

function switchServer(id) {
  if (id === config.data.activeServer) return showMain();
  config.update({ activeServer: id, lastUrl: '' });
  buildMenu();
  showMain();
  refresh();
}

function buildMenu() {
  const servers = config.data.servers.map((s) => ({
    label: s.central ? `${s.name} (central)` : s.name,
    type: 'radio',
    checked: s.id === config.data.activeServer,
    click: () => switchServer(s.id),
  }));
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open settings file', click: () => shell.openPath(config.file) },
        { label: 'Show settings folder', click: () => shell.showItemInFolder(config.file) },
        { label: 'Reload settings', click: reloadConfig },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        ...PAGES.map((p) => ({ label: p.label, accelerator: p.accel, click: () => openPage(p.path) })),
        ...(isMac ? [{ label: 'Mac', accelerator: 'CmdOrCtrl+Shift+M', click: openMac }] : []),
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: goBack },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: goForward },
      ],
    },
    { label: 'Server', submenu: servers },
    {
      // Custom rather than role items: the roles act on a focused
      // BrowserWindow, and the page here lives in a WebContentsView.
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeContents() && activeContents().reload() },
        { label: 'Force reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => activeContents() && activeContents().reloadIgnoringCache() },
        { label: 'Toggle developer tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeContents() && activeContents().toggleDevTools() },
        { type: 'separator' },
        { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(+0.5) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Zoom is per origin in Chromium, so one view's zoom applies to all of them.
function zoom(step) {
  const wc = activeContents();
  if (wc) wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step);
}

function reloadConfig() {
  config.load();
  buildMenu();
  ntfy.start(config.data.ntfy);
  ensureMainWindow();
  if (macView) loadMac();
  // A changed device restarts the runner on the new name; off stops it.
  const r = runner.status();
  if (!config.data.runner.on) runner.stop();
  else if (!r.on || r.device !== config.data.runner.device) runner.start(config.data.runner.device);
  refresh();
}

// ---------------------------------------------------------------- data

function panelState() {
  return {
    at: statusAt,
    ntfy: { ...ntfyStatus, topics: config.data.ntfy.topics.length },
    genvMac: { ...genvStatus, actions: genvStatus.available ? genvMac.actions(genvStatus.state) : [], busy: genvBusy },
    runner: { ...runner.status(), wanted: config.data.runner.on },
    server: { name: config.centralServer.name, url: config.centralServer.url },
  };
}

function pushState() {
  const state = panelState();
  if (macView && !macView.webContents.isDestroyed()) macView.webContents.send('gcm:state', state);
}

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  // Only what the Mac page shows: the web has its own health, today and tickets.
  refreshing = genvMac.status(config.data)
    .then((g) => {
      statusAt = Date.now();
      genvStatus = g;
      pushState();
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    refresh();
    ensureStudioSessions().catch(() => {});
  }, config.data.pollSeconds * 1000);
}

// ---------------------------------------------------------------- ntfy

ntfy.on('status', (s) => {
  ntfyStatus = s;
  debug({ ntfy: s.status });
  pushState();
});

ntfy.on('message', (msg) => {
  const target = route(msg, config);
  debug({ notified: msg.title, target: target.url, supported: Notification.isSupported() });
  if (Notification.isSupported()) {
    const n = new Notification({
      title: msg.title || 'G-Command',
      body: msg.message,
      urgency: msg.priority >= 5 ? 'critical' : msg.priority >= 4 ? 'normal' : 'low',
      silent: msg.priority <= 2,
    });
    n.on('click', () => (target.kind === 'app' ? openUrl(target.url) : shell.openExternal(target.url)));
    n.show();
  }
  if (msg.priority >= 4 || /status|reminder|ticket/i.test(msg.title)) refresh();
});

// ---------------------------------------------------------------- ipc

ipcMain.handle('gcm:state', () => panelState());
ipcMain.handle('gcm:refresh', async () => {
  await refresh();
  return panelState();
});
ipcMain.handle('gcm:genv', async (_e, args) => {
  // Only a verb the Mac page was shown, so a renderer can never run arbitrary genv.
  if (!Array.isArray(args) || !genvStatus.available || !genvMac.allowed(genvStatus.state, args)) {
    return { ok: false, output: 'That action is not offered right now' };
  }
  genvBusy = args.join(' ');
  pushState();
  const res = await genvMac.run(config.data, args);
  genvBusy = null;
  await refresh();
  return res;
});
ipcMain.handle('gcm:runner', (_e, on) => {
  config.update({ runner: { ...config.data.runner, on: on === true } });
  if (on === true) runner.start(config.data.runner.device);
  else runner.stop();
  return panelState();
});
ipcMain.on('gcm:open', (_e, target) => {
  if (!target || typeof target !== 'object') return;
  if (target.kind === 'page' && typeof target.path === 'string' && target.path.startsWith('/')) {
    openPage(target.path, config.centralServer.id);
  } else if (target.kind === 'note' && typeof target.permalink === 'string' && target.permalink) {
    openPage(`/note/${target.permalink.split('/').map(encodeURIComponent).join('/')}`, config.centralServer.id);
  } else if (target.kind === 'settings') {
    shell.openPath(config.file);
  }
});

// ---------------------------------------------------------------- screenshots

async function captureScreens() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = ensureMainWindow();
  const wc = activeContents();
  await new Promise((r) => (wc.isLoading() ? wc.once('did-stop-loading', r) : r()));
  m.win.showInactive();
  await wait(2500);
  fs.writeFileSync(path.join(SHOTS, 'main-window.png'), (await wc.capturePage()).toPNG());
  // Sign in only after the main window is captured, so the docs shot shows
  // the login page rather than live data.
  if (process.env.GCM_LOGIN_PASSWORD) await testLogin(process.env.GCM_LOGIN_PASSWORD);
  await refresh();
  openMac();
  await wait(800);
  const mv = ensureMacView();
  const consoleErrors = [];
  mv.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') consoleErrors.push(e.message);
  });
  if (mv.webContents.isLoading()) await new Promise((r) => mv.webContents.once('did-finish-load', r));
  await wait(1500);
  fs.writeFileSync(path.join(SHOTS, 'mac-page.png'), (await mv.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(SHOTS, 'main-window-mac-rail.png'), (await wc.capturePage()).toPNG());
  if (process.env.GCM_SHOT_THEME) {
    await mv.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(process.env.GCM_SHOT_THEME)}`);
    await wait(500);
    fs.writeFileSync(path.join(SHOTS, `mac-page-${process.env.GCM_SHOT_THEME}.png`), (await mv.webContents.capturePage()).toPNG());
  }
  if (process.env.GCM_SMOKE_WAIT_MS) await wait(Number(process.env.GCM_SMOKE_WAIT_MS));
  const runnerPage = await runner.probe();
  console.log(JSON.stringify({ screenshots: SHOTS, ntfy: ntfyStatus, genvMac: genvStatus.available, runner: runner.status(), runnerPage, consoleErrors }));
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- lifecycle

// ---------------------------------------------------------------- studio owner key
//
// The embedded G Studio signs in as Gabriel with the owner key (studio-key.js).
// The key stays in this process; pages only ever see the session cookie.

const STUDIO_ORIGIN = () => config.data.studioOrigin || config.data.authOrigins[0] || '';
const KEY_FLAG = process.argv.includes('--install-studio-key');
const UNKEY_FLAG = process.argv.includes('--remove-studio-key');

async function ensureStudioSessions() {
  const key = studioKey.load(app.getPath('userData'), safeStorage);
  if (!key) return [];
  const results = [];
  for (const server of config.data.servers) {
    const ses = session.fromPartition(partitionFor(server));
    const r = await studioKey.ensureSession({ ses, origin: STUDIO_ORIGIN(), key });
    results.push(r);
    if (r === 'renewed' && main && main.server.id === server.id) {
      // A studio page that already gave up on sign-in starts again, signed in.
      for (const v of main.views.values()) {
        try {
          if (new URL(v.webContents.getURL()).pathname.startsWith('/studio')) v.webContents.reload();
        } catch {}
      }
    }
  }
  debug({ studioSession: results });
  return results;
}

async function installStudioKey() {
  const dir = app.getPath('userData');
  try {
    if (UNKEY_FLAG) {
      console.log(studioKey.remove(dir) ? 'Removed the studio owner key.' : 'No studio owner key was installed.');
    } else {
      const id = studioKey.store(dir, safeStorage, await studioKey.readStdin());
      console.log(`Installed studio owner key ${id}.`);
    }
    app.exit(0);
  } catch (err) {
    console.error(err.message);
    app.exit(1);
  }
}

if (KEY_FLAG || UNKEY_FLAG) {
  // Setup only: `... owner-key mint | G-Command --install-studio-key`. Runs
  // beside a running app (no single-instance lock) and opens no window.
  app.whenReady().then(installStudioKey);
} else if (!SHOTS && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(async () => {
    config.load();
    buildMenu();
    ntfy.start(config.data.ntfy);
    startPolling();
    if (config.data.runner.on || process.env.GCM_RUNNER === '1') runner.start(config.data.runner.device);
    if (SHOTS) return captureScreens();
    if (process.env.GCM_LOGIN_PASSWORD) await testLogin(process.env.GCM_LOGIN_PASSWORD);
    // Launched at login with --hidden: build and warm the window but keep it
    // off screen until the dock icon asks for it.
    hiddenLaunch = process.argv.includes('--hidden');
    if (hiddenLaunch) ensureMainWindow();
    else showMain();
    refresh();
    // Not awaited: a renewal reloads any studio page that loaded signed out.
    ensureStudioSessions().catch(() => {});
  });

  app.on('activate', showMain);
  app.on('before-quit', () => {
    quitting = true;
    ntfy.stop();
    runner.stop();
  });
  app.on('window-all-closed', () => {});
}

// Test hook only: signs the central server's session in through g-command-web's
// own login endpoint, so a headless smoke run can exercise the tickets feed.
// The password comes from the environment and is never written anywhere.
async function testLogin(password) {
  const central = config.centralServer;
  const ses = session.fromPartition(partitionFor(central));
  const res = await ses.fetch(`${central.url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'include',
  });
  console.log(JSON.stringify({ testLogin: res.status }));
}
