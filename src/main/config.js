'use strict';

// Device-local configuration. The file lives in Electron's userData directory
// (~/Library/Application Support/g-command on macOS, ~/.config/g-command on
// Linux) and never in the repo: it carries the ntfy topic and token, which are
// secrets. Unknown keys are kept on save so a newer build can add fields
// without an older one dropping them.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  servers: [
    { id: 'central', name: 'Central', url: 'http://127.0.0.1:8080', central: true },
  ],
  activeServer: 'central',
  brainApi: 'http://127.0.0.1:8766',
  pollSeconds: 60,
  ntfy: {
    server: 'https://ntfy.sh',
    topics: [],
    token: '',
  },
  routes: [],
  genvMac: {
    path: '',
  },
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'server';
}

function normaliseServers(list) {
  if (!Array.isArray(list) || list.length === 0) return clone(DEFAULTS.servers);
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || typeof s.url !== 'string') continue;
    let url;
    try {
      url = new URL(s.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    let id = slug(s.id || s.name || url.hostname);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    out.push({ ...s, id, name: s.name || url.hostname, url: url.origin, central: !!s.central });
  }
  if (out.length === 0) return clone(DEFAULTS.servers);
  if (!out.some((s) => s.central)) out[0].central = true;
  return out;
}

function normalise(raw) {
  const c = { ...clone(DEFAULTS), ...(raw && typeof raw === 'object' ? raw : {}) };
  c.servers = normaliseServers(c.servers);
  if (!c.servers.some((s) => s.id === c.activeServer)) {
    c.activeServer = (c.servers.find((s) => s.central) || c.servers[0]).id;
  }
  c.ntfy = { ...DEFAULTS.ntfy, ...(c.ntfy || {}) };
  if (typeof c.ntfy.topics === 'string') c.ntfy.topics = c.ntfy.topics.split(',');
  c.ntfy.topics = (c.ntfy.topics || []).map((t) => String(t).trim()).filter(Boolean);
  c.ntfy.server = String(c.ntfy.server || DEFAULTS.ntfy.server).replace(/\/+$/, '');
  c.genvMac = { ...DEFAULTS.genvMac, ...(c.genvMac || {}) };
  c.brainApi = String(c.brainApi || DEFAULTS.brainApi).replace(/\/+$/, '');
  c.pollSeconds = Math.max(15, Number(c.pollSeconds) || DEFAULTS.pollSeconds);
  if (!Array.isArray(c.routes)) c.routes = [];
  return c;
}

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = null;
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A broken file is moved aside rather than overwritten, so a typo
        // never costs the token that was in it.
        try {
          fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {}
      }
    }
    this.data = normalise(raw);
    if (!raw) this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(patch) {
    this.data = normalise({ ...this.data, ...patch });
    this.save();
    return this.data;
  }

  get activeServer() {
    return this.data.servers.find((s) => s.id === this.data.activeServer);
  }

  get centralServer() {
    return this.data.servers.find((s) => s.central) || this.data.servers[0];
  }

  serverForUrl(url) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    return this.data.servers.find((s) => s.url === origin) || null;
  }
}

function partitionFor(server) {
  return `persist:server-${server.id}`;
}

module.exports = { Config, DEFAULTS, normalise, partitionFor };
