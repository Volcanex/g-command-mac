# g-command-mac

The G-System desktop app (Electron): g-command-web in a native window, native
notifications from the ntfy alert spine, and a Mac page in the main window (genv, sticky apps, runner). genv-bar owns the menu bar.
Companion to g-command-web (`Volcanex/g-command-web`). Built on h on
2026-10-09 and finished on the Mac. Builds are unsigned until a Developer ID
certificate is installed (Mac handoff, below).

**Owner:** Gabriel Penman
**Role in supersystem:** a renderer and a spine subscriber. Holds no data of its
own; everything it shows comes from g-command-web and the g-brain REST API.

## Layout
- `src/main/main.js`: lifecycle, main window, app menu, the Mac page overlay (`MAC_NAV_JS`), polling, IPC.
- `src/main/mac-page.js`: the Mac page's URL check and rect clamp (pure, tested).
- `src/main/config.js`: device-local settings, config.json in userData, mode 0600.
- `src/main/ntfy.js`: ntfy JSON-stream subscriber, reconnect and resume.
- `src/main/routes.js`: which g-command-web page a notification opens.
- `src/main/status.js`: health, today and tickets feeds; no longer polled (the web shows them), kept with its tests.
- `src/main/genv-mac.js`: the genv link: `status()` reads `genv status --json`, `run()` runs any genv verb.
- `src/main/runner.js`: runner mode, a hidden window on the g-engine device-runner page (see below).
- `src/preload/mac.js`: the only bridge the Mac page gets (`window.gcm`).
- `src/renderer/`: panel and offline pages. `command.js` fills their `<meta name="g-command">` with the central server's origin, which `main.js` passes as `?command=`. `src/renderer/static/g/` is g-design, vendored.
- `scripts/measure.js`: launch-speed harness (cold launch to real content, page switches, reopen), drives the app only through its menu and lifecycle events.
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
- The main window is a `BaseWindow` holding a pool of `WebContentsView`s, one per `warmPages` entry
  in config.json. A link or Cmd+number to a warm page swaps views; anything else navigates the active view.
  Hidden views are put back on their page or reloaded when older than 90 s. Pool renderers start only
  after the first page settles (starting them earlier cost it about 200 ms), and the window is shown at
  once rather than on dom-ready (a hidden window loads its page about 200 ms slower).
- Sign-in goes through Studio SSO (`authOrigins`, default studio.gabrielpenman.com), kept in-app.
- G Studio signs in by itself with the owner key (`src/main/studio-key.js`, g-studio contracts.md
  "Owner key"). The key is safeStorage-encrypted in userData `studio-owner-key.bin` (0600), never in
  config.json, a renderer or a log. At launch and every poll the main process asks
  `{studioOrigin}/api/auth/me` in each server partition; on 401 it posts the key to
  `/api/app/owner-key` (HTTPS only, loopback http for tests) and sets `__Host-gs_session` there.
  Install: `ssh ... 'gstudio owner-key mint' | "<app binary>" --install-studio-key` (stdin; the same
  binary that runs the app, so the same Keychain item). `--remove-studio-key` deletes it.
- `INSET_CSS` in main.js pads the web sidebar under the traffic lights and makes the top bar the drag
  region. It keys on `aside > .brand-row` and `header.topbar`; if the web renames them, update it.
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
- No tray. On macOS `MAC_NAV_JS` appends a Mac `.nav-item` (under Additional tools) to the web
  rail's `.nav-list`; clicking it navigates to `/__gcm/mac?x&y&w&h` (the content area's rect),
  which will-navigate catches to lay a local `mac.html` view over the content area. Any other
  navigation or view swap hides it. While open the top-bar crumbs read "Mac". The no-rail fallback sits below `TOPBAR_H`, read from INSET_CSS. Go, Mac (Cmd+Shift+M) opens it too. Not offered on Linux.
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

## Runner mode
Replaces `~/mac-runner.sh`. The panel's "Run jobs on this Mac" opens
`https://newcastlev2.gabrielpenman.com/v2/tests/run/?device=<runner.device>` in a hidden
BrowserWindow of its own (partition `persist:runner`, never the main window, so closing that does
not stop it). `backgroundThrottling:false` keeps timers running and keeps
`document.visibilityState` 'visible' while hidden; the page refuses jobs when it reads 'hidden'.
powerSaveBlocker holds `prevent-display-sleep` and `prevent-app-suspension` (the nearest Electron
gets to `caffeinate -dimsu`). A crash or failed load reloads after 5 s. `runner.on` and
`runner.device` (default gabriel-main) live in config.json; File, Reload settings applies a new
device. The page needs no sign-in. `GCM_RUNNER=1` starts it for a test run, and the screenshot run
logs what the page reports (`runnerPage`); use a throwaway device name there so it takes no real job.

## g-env-mac link
`src/main/genv-mac.js` finds a checkout at `config.genvMac.path`, `$G_ENV_MAC_DIR`,
`~/genv` (the live one), `~/g-env-mac`, `~/genv-mac` or the Desktop variants, then runs
`bin/genv status --json` with Homebrew on PATH; `state` is the parsed JSON and
`summary` one readable line. An older checkout without `--json` falls back to the
panel's first line. `run(config, args)` runs any genv verb: the app never
reimplements one. Absent checkout means `{available:false}`, never an error.
`actions(state)` builds the panel's genv buttons; each label names what clicking does (genv-bar's
rule), the current state goes in the detail. The `gcm:genv` IPC runs only verbs `allowed()` says
the panel was shown, then refreshes status.

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
   `spctl -a -vv` on the built G-Command.app and `xcrun stapler validate` on the dmg.
6. **Polish.** Replace the tray images in `src/assets/` with final art;
   consider moving `ntfy.token` to the Keychain via `safeStorage`; add a login
   item (`app.setLoginItemSettings`) if the owner wants it at startup.

## Requested from g-command-web (not done here; this repo owns none of it)
- Deep links: `/tickets?project=&id=` opening one ticket, and `/calendar?date=`
  opening a day. Today every ticket row opens the list.
- Click URLs on spine messages (`Click:` header in `brain_alerts.send`) so routing
  stops depending on titles.
