'use strict';

// Launch-speed harness. Runs an app checkout's main process in-process and
// times, from the moment the shell spawned Electron (GCM_T0), how long until
// the window is on screen with the web page's real content in it, then how
// long page switches and a close-and-reopen take. Drives the app only through
// its own menu and lifecycle events, never the real mouse or keyboard.
//
//   GCM_T0=$(node -e 'console.log(Date.now())') GCM_USER_DATA=<profile copy> \
//     npx electron scripts/measure.js <checkout dir>

const path = require('node:path');
const { app, BaseWindow, Menu } = require('electron');

const appDir = path.resolve(process.argv[process.argv.length - 1]);
const T0 = Number(process.env.GCM_T0) || Date.now();
const results = {};

function visibleContents() {
  for (const win of BaseWindow.getAllWindows()) {
    if (!win.isVisible() || win.getBounds().width < 600) continue;
    const kids = win.contentView.children.filter((c) => c.webContents);
    if (kids.length) {
      const v = kids.find((c) => c.getVisible());
      if (v) return v.webContents;
    }
    if (win.webContents) return win.webContents;
  }
  return null;
}

const PROBE = `(() => {
  const m = document.querySelector('main');
  return { path: location.pathname, ok: document.readyState !== 'loading' && !!m && m.innerText.trim().length > 100 };
})()`;

let firstSeen = 0;
async function until(want, t) {
  for (;;) {
    const wc = visibleContents();
    if (wc && !firstSeen) firstSeen = Date.now();
    if (wc && !wc.isDestroyed()) {
      try {
        const r = await wc.executeJavaScript(PROBE, true);
        if (r.ok && (!want || r.path === want)) return Date.now() - t;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

function clickMenu(label) {
  const go = Menu.getApplicationMenu().items.find((i) => i.label === 'Go');
  const item = go.submenu.items.find((i) => i.label === label);
  item.click();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let readyAt; app.whenReady().then(async () => { readyAt = Date.now();
  results.cold = await until(null, T0); results.ready = readyAt - T0; results.windowShown = firstSeen - T0;
  await wait(10000); // let any warm pool fill, as it would in real use
  for (const [label, p] of [['Calendar', '/calendar'], ['Tickets', '/tickets'], ['Home', '/']]) {
    const t = Date.now();
    clickMenu(label);
    results[`switch ${p}`] = await until(p, t);
    await wait(1500);
  }
  const win = BaseWindow.getAllWindows().find((w) => w.getBounds().width >= 600);
  win.close();
  await wait(1500);
  const t = Date.now();
  app.emit('activate');
  results.reopen = await until(null, t);
  console.log(JSON.stringify({ measure: results }));
  process.exit(0);
});

require(path.join(appDir, 'src', 'main', 'main.js'));
