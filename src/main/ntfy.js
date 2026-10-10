'use strict';

// One more decoupled subscriber on the alert spine, beside the phone and the
// TV. It holds ntfy's JSON stream open (GET /<topics>/json), reconnects with
// backoff, and resumes from the last message id it saw so nothing sent while
// the laptop slept is lost (ntfy.sh keeps messages for 12 hours).
//
// The topic name on ntfy.sh is effectively a password: never log the URL.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const RESUME_WINDOW_S = 12 * 3600;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const STALL_MS = 90 * 1000; // ntfy sends a keepalive every 45s

function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  try {
    const ev = JSON.parse(s);
    return ev && typeof ev === 'object' ? ev : null;
  } catch {
    return null;
  }
}

function buildUrl(server, topics, since) {
  const u = new URL(`${server}/${topics.map(encodeURIComponent).join(',')}/json`);
  if (since) u.searchParams.set('since', since);
  return u.toString();
}

class NtfySubscriber extends EventEmitter {
  constructor({ stateDir, fetchImpl } = {}) {
    super();
    this.stateFile = stateDir ? path.join(stateDir, 'ntfy-state.json') : null;
    this.fetch = fetchImpl || globalThis.fetch;
    this.settings = null;
    this.controller = null;
    this.timer = null;
    this.backoff = 2000;
    this.seen = new Set();
    this.state = this.readState();
    this.status = 'off';
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  writeState() {
    if (!this.stateFile) return;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state), { mode: 0o600 });
    } catch {}
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail: detail || '' });
  }

  start(settings) {
    this.stop();
    this.settings = settings;
    if (!settings || !settings.server || !settings.topics || settings.topics.length === 0) {
      this.setStatus('off', 'No topics configured');
      return;
    }
    this.connect();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.controller) this.controller.abort();
    this.controller = null;
  }

  since() {
    const { lastId, lastTime } = this.state;
    if (!lastId || !lastTime) return null;
    return Date.now() / 1000 - lastTime < RESUME_WINDOW_S ? lastId : null;
  }

  async connect() {
    const { server, topics, token } = this.settings;
    const controller = new AbortController();
    this.controller = controller;
    let stall;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), STALL_MS);
    };
    this.setStatus('connecting');
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      arm();
      const res = await this.fetch(buildUrl(server, topics, this.since()), {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
      this.setStatus('live');
      this.backoff = 2000;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        arm();
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          this.handle(parseLine(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      }
      throw new Error('ntfy closed the stream');
    } catch (err) {
      clearTimeout(stall);
      if (this.controller !== controller) return; // stopped or restarted
      this.setStatus('retrying', err.message);
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
  }

  handle(ev) {
    if (!ev || ev.event !== 'message' || !ev.id) return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    this.state = { lastId: ev.id, lastTime: ev.time || Math.floor(Date.now() / 1000) };
    this.writeState();
    this.emit('message', {
      id: ev.id,
      time: ev.time,
      topic: ev.topic,
      title: ev.title || '',
      message: ev.message || '',
      tags: Array.isArray(ev.tags) ? ev.tags : [],
      priority: ev.priority || 3,
      click: ev.click || '',
    });
  }
}

module.exports = { NtfySubscriber, parseLine, buildUrl };
