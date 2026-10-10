'use strict';

// The three at-a-glance feeds for the menu-bar panel. All of them are real
// endpoints that g-command-web already uses; none is new:
//
//   health   GET {brainApi}/api/status                 public, CORS *
//            (brain L5 snapshot, the same feed g-command-web /system polls)
//   today    GET {brainApi}/api/todos/calendar?date_from=D&date_to=D
//            public, CORS * (the same feed g-command-web /calendar renders)
//   tickets  GET {central}/api/gadmin_panel/tickets?status=open
//            behind g-command-web's whole-site cookie gate, so it is fetched
//            through the server's persistent session: it works once the
//            user has signed in to g-command-web in the main window.

function isoDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function getJson(fetchImpl, url, opts = {}) {
  const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function health(fetchImpl, brainApi) {
  const d = await getJson(fetchImpl, `${brainApi}/api/status`);
  // A dependency nobody probes reports 'unknown'. Listing those would bury
  // the services that are actually down, so only probed failures count.
  const bad = [
    ...(d.services || []).filter((s) => s.state && s.state !== 'up'),
    ...(d.dependencies || []).filter((s) => s.state === 'down' || s.state === 'warn'),
  ]
    .map((s) => ({
      id: s.id,
      kind: s.kind || 'service',
      state: s.state,
      detail: s.detail || '',
    }));
  const rank = { down: 0, warn: 1, unknown: 2 };
  bad.sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3));
  const sum = d.summary || {};
  const dep = d.dep_summary || {};
  const down = (sum.down || 0) + (dep.down || 0);
  const warn = (sum.warn || 0) + (dep.warn || 0);
  return {
    checkedAt: d.checked_at || null,
    services: sum,
    dependencies: dep,
    level: down ? 'down' : warn ? 'warn' : 'up',
    issues: bad,
  };
}

async function today(fetchImpl, brainApi, day = isoDay()) {
  const url = `${brainApi}/api/todos/calendar?date_from=${day}&date_to=${day}`;
  const items = await getJson(fetchImpl, url);
  const list = (Array.isArray(items) ? items : []).map((t) => ({
    slug: t.slug,
    permalink: t.permalink,
    title: t.title || t.slug,
    time: t.time || null,
    vital: !!t.vital,
    urgent: !!t.urgent,
    done: !!t.done,
    failed: !!t.failed,
    dropped: !!t.dropped,
    lateDays: t.late_days || 0,
  }));
  const open = list.filter((t) => !t.done && !t.failed && !t.dropped);
  return { day, open, settled: list.length - open.length };
}

async function tickets(sessionFetch, centralUrl) {
  try {
    const d = await getJson(sessionFetch, `${centralUrl}/api/gadmin_panel/tickets?status=open`, {
      credentials: 'include',
    });
    const list = (d.tickets || []).map((t) => ({
      id: t.id,
      project: t.project,
      severity: t.severity || 'plain',
      title: (t.page && t.page.title) || t.note || t.id,
      updatedAt: t.updated_at || t.created_at || null,
    }));
    return { signedIn: true, open: list, degraded: d.degraded || [] };
  } catch (err) {
    if (err.status === 401) return { signedIn: false, open: [], degraded: [] };
    throw err;
  }
}

async function settle(p) {
  try {
    return { ok: true, data: await p };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function snapshot({ fetchImpl, sessionFetch, brainApi, centralUrl }) {
  const [h, t, k] = await Promise.all([
    settle(health(fetchImpl, brainApi)),
    settle(today(fetchImpl, brainApi)),
    settle(tickets(sessionFetch, centralUrl)),
  ]);
  return { at: new Date().toISOString(), health: h, today: t, tickets: k };
}

module.exports = { snapshot, health, today, tickets, isoDay };
