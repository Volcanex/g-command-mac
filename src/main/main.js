'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} = require('electron');

const { Config, partitionFor } = require('./config');
const { NtfySubscriber } = require('./ntfy');
const { route } = require('./routes');
const status = require('./status');
const genvMac = require('./genv-mac');

const isMac = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', 'assets');
const SHOTS = process.env.GCM_SCREENSHOTS || '';
const REDACT = process.env.GCM_REDACT === '1';
const DEBUG = process.env.GCM_DEBUG === '1';
const debug = (o) => DEBUG && console.log(JSON.stringify(o));

// GCM_USER_DATA isolates a test run from the real profile; it must be set
// before anything reads userData.
if (process.env.GCM_USER_DATA) app.setPath('userData', process.env.GCM_USER_DATA);
app.setName('g-command');

const config = new Config(app.getPath('userData'));
const ntfy = new NtfySubscriber({ stateDir: app.getPath('userData') });

let mainWindow = null;
let panel = null;
let tray = null;
let quitting = false;
let pollTimer = null;
let latest = { at: null, health: null, today: null, tickets: null };
let ntfyStatus = { status: 'off', detail: '' };
let genvStatus = { available: false, reason: 'Not checked yet' };

const PAGES = [
  { label: 'Home', path: '/', accel: 'CmdOrCtrl+1' },
  { label: 'System', path: '/system', accel: 'CmdOrCtrl+2' },
  { label: 'Calendar', path: '/calendar', accel: 'CmdOrCtrl+3' },
  { label: 'Todos', path: '/todos', accel: 'CmdOrCtrl+4' },
  { label: 'Tickets', path: '/tickets', accel: 'CmdOrCtrl+5' },
];

function isOwnUrl(url) {
  return !!config.serverForUrl(url);
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwnUrl(url)) {
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

function createMainWindow(server) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'g-command',
    backgroundColor: '#111113',
    // Standard title bar: an inset one put the traffic lights over the
    // web page's logo, and this app does not own that page's layout.
    titleBarStyle: 'default',
    webPreferences: {
      partition: partitionFor(server),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  hardenContents(win.webContents);
  win.once('ready-to-show', () => {
    if (!SHOTS) win.show();
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    win.loadFile(path.join(__dirname, '..', 'renderer', 'offline.html'), {
      query: { server: server.name, url, reason: desc, command: config.centralServer.url },
    });
  });
  win.loadURL(server.url);
  win.serverId = server.id;
  return win;
}

// Each server has its own persistent partition, so signing in to one never
// leaks a cookie to another, and switching servers rebuilds the window.
function ensureMainWindow() {
  const server = config.activeServer;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.serverId === server.id) return mainWindow;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  mainWindow = createMainWindow(server);
  return mainWindow;
}

function showMain() {
  const win = ensureMainWindow();
  if (!SHOTS) {
    win.show();
    win.focus();
  }
  return win;
}

function openUrl(url) {
  const server = config.serverForUrl(url);
  if (server && server.id !== config.data.activeServer) {
    config.update({ activeServer: server.id });
    buildMenu();
  }
  const win = showMain();
  if (win.webContents.getURL() !== url) win.loadURL(url);
}

function openPage(p, serverId) {
  const server = config.data.servers.find((s) => s.id === serverId) || config.activeServer;
  openUrl(new URL(p, server.url).toString());
}

function switchServer(id) {
  if (id === config.data.activeServer) return showMain();
  config.update({ activeServer: id });
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
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => mainWindow && mainWindow.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => mainWindow && mainWindow.webContents.navigationHistory.goForward() },
      ],
    },
    { label: 'Server', submenu: servers },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (tray && !isMac) tray.setContextMenu(trayMenu());
}

function reloadConfig() {
  config.load();
  buildMenu();
  ntfy.start(config.data.ntfy);
  ensureMainWindow();
  if (panel && !panel.isDestroyed()) loadPanel();
  refresh();
}

// ---------------------------------------------------------------- tray

function trayIcon() {
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(ASSETS, file));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show status panel', click: togglePanel },
    { label: 'Open g-command', click: showMain },
    { type: 'separator' },
    ...PAGES.slice(1).map((p) => ({ label: `Open ${p.label.toLowerCase()}`, click: () => openPage(p.path) })),
    { type: 'separator' },
    { label: 'Refresh', click: refresh },
    { label: 'Quit g-command', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('g-command');
  if (isMac) {
    // On macOS a context menu would swallow the left click, so the panel
    // takes the left click and the menu only appears on right click.
    tray.on('click', togglePanel);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  } else {
    // Linux app indicators only deliver clicks through a menu.
    tray.setContextMenu(trayMenu());
    tray.on('click', togglePanel);
  }
}

function createPanel() {
  panel = new BrowserWindow({
    width: 380,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#111113',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (isMac) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.on('blur', () => {
    if (!SHOTS && !panel.webContents.isDevToolsOpened()) panel.hide();
  });
  hardenContents(panel.webContents);
  loadPanel();
}

// The central server is the g-command-web the admin bar links to; command.js
// copies it into <meta name="g-command">.
function loadPanel() {
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'), {
    query: { command: config.centralServer.url },
  });
}

function positionPanel() {
  const [w, h] = panel.getSize();
  const tb = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const display = tb.width ? screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  let x;
  let y;
  if (tb.width) {
    x = Math.round(tb.x + tb.width / 2 - w / 2);
    y = tb.y < wa.y + wa.height / 2 ? tb.y + tb.height + 4 : tb.y - h - 4;
  } else {
    x = wa.x + wa.width - w - 8;
    y = wa.y + 8;
  }
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - w - 4);
  panel.setPosition(x, y, false);
}

function togglePanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  positionPanel();
  panel.show();
  panel.focus();
  refresh();
}

// ---------------------------------------------------------------- data

function redacted(snap) {
  const s = JSON.parse(JSON.stringify(snap));
  if (s.today && s.today.ok) {
    s.today.data.open = s.today.data.open.map((t, i) => ({ ...t, title: `Example task ${i + 1}`, permalink: '' }));
  }
  if (s.tickets && s.tickets.ok) {
    s.tickets.data.open = s.tickets.data.open.map((t, i) => ({ ...t, title: `Example ticket ${i + 1}`, project: 'example' }));
  }
  return s;
}

function panelState() {
  const snap = REDACT ? redacted(latest) : latest;
  return {
    ...snap,
    ntfy: { ...ntfyStatus, topics: config.data.ntfy.topics.length },
    genvMac: genvStatus,
    server: { name: config.centralServer.name, url: config.centralServer.url },
  };
}

function pushState() {
  const state = panelState();
  if (panel && !panel.isDestroyed()) panel.webContents.send('gcm:state', state);
  if (!tray) return;
  const h = latest.health && latest.health.ok ? latest.health.data : null;
  const issues = h ? h.issues.filter((i) => i.state === 'down' || i.state === 'warn').length : 0;
  tray.setToolTip(h ? (issues ? `g-command: ${issues} need attention` : 'g-command: all systems up') : 'g-command');
  if (isMac) tray.setTitle(issues ? String(issues) : '');
}

let refreshing = null;
function refresh() {
  if (refreshing) return refreshing;
  const central = config.centralServer;
  const ses = session.fromPartition(partitionFor(central));
  refreshing = Promise.all([
    status.snapshot({
      fetchImpl: globalThis.fetch,
      sessionFetch: (url, opts) => ses.fetch(url, opts),
      brainApi: config.data.brainApi,
      centralUrl: central.url,
    }),
    genvMac.status(config.data),
  ])
    .then(([snap, g]) => {
      latest = snap;
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
  pollTimer = setInterval(refresh, config.data.pollSeconds * 1000);
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
      title: msg.title || 'g-command',
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
ipcMain.on('gcm:open', (_e, target) => {
  if (!target || typeof target !== 'object') return;
  if (target.kind === 'page' && typeof target.path === 'string' && target.path.startsWith('/')) {
    openPage(target.path, config.centralServer.id);
  } else if (target.kind === 'note' && typeof target.permalink === 'string' && target.permalink) {
    openPage(`/note/${target.permalink.split('/').map(encodeURIComponent).join('/')}`, config.centralServer.id);
  } else if (target.kind === 'settings') {
    shell.openPath(config.file);
  }
  if (panel && !SHOTS) panel.hide();
});

// ---------------------------------------------------------------- screenshots

async function captureScreens() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const win = ensureMainWindow();
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-stop-loading', r) : r()));
  win.showInactive();
  await wait(2500);
  fs.writeFileSync(path.join(SHOTS, 'main-window.png'), (await win.webContents.capturePage()).toPNG());
  // Sign in only after the main window is captured, so the docs shot shows
  // the login page rather than live data.
  if (process.env.GCM_LOGIN_PASSWORD) await testLogin(process.env.GCM_LOGIN_PASSWORD);
  createPanel();
  const consoleErrors = [];
  panel.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') consoleErrors.push(e.message);
  });
  await new Promise((r) => panel.webContents.once('did-finish-load', r));
  await refresh();
  await wait(500);
  // Grow the panel to its content so one shot shows every section.
  const full = await panel.webContents.executeJavaScript(
    "document.getElementById('body').scrollHeight + document.querySelector('.head').offsetHeight + document.querySelector('.foot').offsetHeight",
  );
  panel.setResizable(true);
  panel.setSize(380, Math.min(Math.ceil(full) + 4, 1000));
  positionPanel();
  panel.showInactive();
  await wait(1500);
  fs.writeFileSync(path.join(SHOTS, 'tray-panel.png'), (await panel.webContents.capturePage()).toPNG());
  if (process.env.GCM_SHOT_THEME) {
    await panel.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(process.env.GCM_SHOT_THEME)}`);
    await wait(500);
    fs.writeFileSync(path.join(SHOTS, `tray-panel-${process.env.GCM_SHOT_THEME}.png`), (await panel.webContents.capturePage()).toPNG());
  }
  if (process.env.GCM_SMOKE_WAIT_MS) await wait(Number(process.env.GCM_SMOKE_WAIT_MS));
  console.log(JSON.stringify({ screenshots: SHOTS, snapshot: summarise(latest), ntfy: ntfyStatus, genvMac: genvStatus.available, consoleErrors }));
  quitting = true;
  app.quit();
}

function summarise(s) {
  const pick = (r, f) => (r && r.ok ? f(r.data) : `error: ${r && r.error}`);
  return {
    health: pick(s.health, (d) => `${d.level}, ${d.issues.length} issues`),
    today: pick(s.today, (d) => `${d.open.length} open, ${d.settled} settled`),
    tickets: pick(s.tickets, (d) => (d.signedIn ? `${d.open.length} open` : 'signed out')),
  };
}

// ---------------------------------------------------------------- lifecycle

if (!SHOTS && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  app.whenReady().then(async () => {
    config.load();
    buildMenu();
    createTray();
    ntfy.start(config.data.ntfy);
    startPolling();
    if (SHOTS) return captureScreens();
    if (process.env.GCM_LOGIN_PASSWORD) await testLogin(process.env.GCM_LOGIN_PASSWORD);
    showMain();
    refresh();
  });

  app.on('activate', showMain);
  app.on('before-quit', () => {
    quitting = true;
    ntfy.stop();
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
