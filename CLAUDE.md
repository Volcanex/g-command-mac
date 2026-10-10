# g-command-mac

The G-System desktop app (Electron): g-command-web in a native window, native
notifications from the ntfy alert spine, and a menu-bar status panel.
Companion to g-command-web (`Volcanex/g-command-web`). Built on h on
2026-10-09 and finished on the Mac. Builds are unsigned until a Developer ID
certificate is installed (Mac handoff, below).

**Owner:** Gabriel Penman
**Role in supersystem:** a renderer and a spine subscriber. Holds no data of its
own; everything it shows comes from g-command-web and the g-brain REST API.

## Layout
- `src/main/main.js`: lifecycle, main window, app menu, tray, panel window, polling, IPC.
- `src/main/config.js`: device-local settings, config.json in userData, mode 0600.
- `src/main/ntfy.js`: ntfy JSON-stream subscriber, reconnect and resume.
- `src/main/routes.js`: which g-command-web page a notification opens.
- `src/main/status.js`: the three panel feeds (health, today, tickets).
- `src/main/genv-mac.js`: the g-env-mac link. **Stub**, see below.
- `src/preload/panel.js`: the only bridge the panel gets (`window.gcm`).
- `src/renderer/`: panel and offline pages. `command.js` fills their `<meta name="g-command">` with the central server's origin, which `main.js` passes as `?command=`. `src/renderer/static/g/` is g-design, vendored.
- `scripts/smoke.js`: headless smoke run under xvfb, writes `docs-screens/` unless given a directory.
- `build/`: app icon and macOS entitlements. `icon.png` is rendered by `scripts/icon.sh` from
  the g mark vendored from g-design (`src/renderer/static/g/brand/icon.svg`); change the mark in g-design, re-vendor, re-render. `electron-builder.yml`: packaging.

## Run
```
npm install && npm start      # on Linux as root: npx electron . --no-sandbox
npm test                      # node:test, pure modules only
npm run dist:linux && npm run smoke   # GCM_SMOKE_SERVER, GCM_SMOKE_BRAIN_API: hosts to run against
```

## Endpoints (all already used by g-command-web; none invented)
- Health: `GET {brainApi}/api/status`, public, CORS `*`.
- Today: `GET .../api/todos/calendar?date_from=D&date_to=D`, public. Rows open `/note/{permalink}`.
- Tickets: `GET {central}/api/gadmin_panel/tickets?status=open`, behind g-command-web's
  cookie gate (the cookie its `ADMIN_COOKIE` names). Fetched with `session.fromPartition(...).fetch(...,
  {credentials:'include'})`, so it rides the cookie from signing in in the main
  window. A 401 shows "Sign in to see tickets" rather than an error.
- Alerts: `GET {ntfy.server}/{topics}/json?since=<lastId>`, bearer token optional.

## Gotchas
- **The ntfy topic is a secret.** On ntfy.sh, knowing the topic is enough to read
  and publish. It lives only in config.json; never log the stream URL, never
  commit a topic. The spine's topic is the path of `NTFY_URL` in the
  instance checkout's `.env`.
- The spine's senders don't set a Click URL today, so `src/main/routes.js` routes by title:
  g-brain's `outlets/remind.py` titles pings "Reminder", "Vital reminder", "Catching up (n)", and
  g-brain's `brain_status.py` titles them with the service id and tags them `warning` or
  `rotating_light`. If a sender changes its titles, update `DEFAULT_RULES`.
- One persistent partition per server (`persist:server-<id>`), so cookies never
  cross hosts. Switching server rebuilds the main window.
- Navigation off the configured servers' origins is blocked in-app and handed to
  the default browser (`hardenContents`). Add a host to `servers` to keep it in-app.
- macOS tray: left click opens the panel, right click the menu, because a context
  menu set on the tray would swallow the left click. Linux indicators only deliver
  clicks through a menu, so there the menu carries "Show status panel".
- Under xvfb `Notification.isSupported()` is false (no notification daemon), so
  the smoke test checks the routing log line, not a visible notification.
- `npm install` may skip Electron's binary download in this environment; run
  `node node_modules/electron/install.js` if `node_modules/electron/dist` is missing.
- Cross-building the Mac zip on Linux with electron-builder dereferences the
  framework symlinks (a 355 MB zip with three copies of Electron Framework, which
  will not sign). Build Mac artefacts on the Mac. The one Linux-made zip in
  `dist/` was re-zipped with `zip -y` and is for a quick look only.
- Test hooks in `src/main/main.js`, all off unless set: `GCM_USER_DATA` (throwaway profile),
  `GCM_SCREENSHOTS` (capture and quit), `GCM_REDACT` (placeholder titles in shots),
  `GCM_DEBUG`, `GCM_LOGIN_PASSWORD` (signs the test session in via
  `/api/admin/login`; never written anywhere).
- `docs-screens/` holds example data only. The tray shots come from a stand-in server that serves g-core's
  example manifest ids under the host `command.example.com`. A smoke run against
  a live server writes that server's host and real service ids there, so give it a scratch directory
  (`node scripts/smoke.js /tmp/shots`) and never commit what it takes.
- UI follows the g-design skill. Re-vendor with
  `node ../g-design/scripts/vendor.mjs src/renderer/static/g` from a g-design checkout beside this one,
  and never hand-edit those files.
- `DEFAULTS` in `src/main/config.js` point at a g-command-web and a g-brain API on
  the same machine. The first run writes them into config.json, so changing them
  never moves an existing install, and a new install needs its own hosts set there.

## g-env-mac link (stub)
`src/main/genv-mac.js` finds a checkout at `config.genvMac.path`, `$G_ENV_MAC_DIR`,
`~/g-env-mac`, `~/genv-mac`, `~/Desktop/g-env-mac` or `~/Desktop/genv-mac`, then runs
`bin/genv status` with Homebrew on PATH and shows its first line. That verb prints
a rich panel, not JSON. Absent checkout means `{available:false}`, never an error.

## Mac handoff
What the Mac agent must do, in order:
1. **Install.** `git clone https://github.com/Volcanex/g-command-mac`, Node 22+,
   `npm install`, `npm test`, `npm start`. Sign in to g-command-web in the window.
2. **Configure.** Open File, Open settings file. Set `ntfy.topics` to the spine
   topic (path of `NTFY_URL` from the instance passport or its `.env`), and `ntfy.token`
   if the topic is ever access-controlled. Add other servers if wanted. File,
   Reload settings. Send a test alert (`python -m brain_alerts --level info
   --source Reminder test` on h) and check it arrives and opens /calendar.
3. **Link g-env-mac.** Set `genvMac.path` to the checkout (`g-env-mac`). Confirm `bin/genv status` runs from a Finder-launched app. Better:
   add `genv status --json` to g-env-mac and switch `STATUS_ARGS` and the parsing
   in `src/main/genv-mac.js` to it.
4. **Sign.** Install a Developer ID Application certificate in the login keychain.
   In `electron-builder.yml` remove `identity: null` (or set it to the certificate
   name), set `dmg.sign` as wanted, keep `hardenedRuntime: true`. Review
   `build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist`; they hold only what Electron needs plus
   `network.client`.
5. **Notarise.** Export `APPLE_API_KEY` (path to the .p8), `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER` (or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`), set `mac.notarize: true`, run `npm run dist:mac`, then
   `spctl -a -vv` on the built g-command.app and `xcrun stapler validate` on the dmg.
6. **Polish.** Replace the tray images in `src/assets/` with final art;
   consider moving `ntfy.token` to the Keychain via `safeStorage`; add a login
   item (`app.setLoginItemSettings`) if the owner wants it at startup.

## Requested from g-command-web (not done here; this repo owns none of it)
- Deep links: `/tickets?project=&id=` opening one ticket, and `/calendar?date=`
  opening a day. Today every ticket row opens the list.
- Click URLs on spine messages (`Click:` header in `brain_alerts.send`) so routing
  stops depending on titles.
