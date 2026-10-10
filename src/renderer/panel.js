'use strict';

const $ = (id) => document.getElementById(id);
const plain = (s) => (window.g && g.plain ? g.plain(String(s || '')) : String(s || ''));
const MAX_ROWS = 6;

const STATE_BADGE = { up: 'badge-ok', warn: 'badge-warn', down: 'badge-danger', unknown: 'badge-plain' };
const SEVERITY_BADGE = { critical: 'badge-danger', major: 'badge-warn', minor: 'badge-info', polish: 'badge-plain' };
const STATE_WORD = { up: 'Up', warn: 'Warning', down: 'Down', unknown: 'Unknown' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function badge(cls, text) {
  return el('span', `badge ${cls}`, text);
}

function item(parts, target) {
  const b = el('button', 'menu-item');
  for (const p of parts) if (p) b.append(p);
  if (target) b.addEventListener('click', () => window.gcm.open(target));
  else b.classList.add('static');
  return b;
}

function more(text, target) {
  const row = item([el('span', 'label meta', text)], target);
  return row;
}

function note(text) {
  return el('div', 'note', text);
}

function sentence(s) {
  const t = String(s || '');
  return t ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
}

function renderHealth(r) {
  const box = $('health');
  box.replaceChildren();
  $('health-count').textContent = '';
  const page = { kind: 'page', path: '/system' };
  if (!r) return box.append(note('Waiting for the first check'));
  if (!r.ok) return box.append(item([el('span', 'label', 'Status feed did not answer, retrying next poll')], page));
  const d = r.data;
  const svc = d.services || {};
  $('health-count').textContent = `${svc.up || 0} of ${svc.total || 0} up`;
  if (d.issues.length === 0) {
    box.append(item([el('span', 'label', 'All services and dependencies up'), badge('badge-ok', 'Up')], page));
    return;
  }
  for (const i of d.issues.slice(0, MAX_ROWS)) {
    box.append(item([
      el('span', 'label', i.id),
      el('span', 'meta', i.kind === 'dependency' ? 'Dependency' : 'Service'),
      badge(STATE_BADGE[i.state] || 'badge-plain', STATE_WORD[i.state] || sentence(i.state)),
    ], page));
  }
  if (d.issues.length > MAX_ROWS) box.append(more(`${d.issues.length - MAX_ROWS} more on the system page`, page));
}

function renderToday(r) {
  const box = $('today');
  box.replaceChildren();
  $('today-count').textContent = '';
  const cal = { kind: 'page', path: '/calendar' };
  if (!r) return box.append(note('Waiting for the first check'));
  if (!r.ok) return box.append(item([el('span', 'label', 'Todos did not load, retrying next poll')], cal));
  const d = r.data;
  $('today-count').textContent = d.settled ? `${d.open.length} open, ${d.settled} done` : `${d.open.length} open`;
  if (d.open.length === 0) {
    box.append(item([el('span', 'label', 'Nothing left for today')], cal));
    return;
  }
  for (const t of d.open.slice(0, MAX_ROWS)) {
    const target = t.permalink ? { kind: 'note', permalink: t.permalink } : cal;
    box.append(item([
      el('span', 'time num', t.time || ''),
      el('span', 'label', plain(t.title)),
      t.lateDays > 0 ? badge('badge-warn', t.lateDays === 1 ? '1 day late' : `${t.lateDays} days late`) : null,
      t.vital ? badge('badge-danger', 'Vital') : t.urgent ? badge('badge-info', 'Starred') : null,
    ], target));
  }
  box.append(more(d.open.length > MAX_ROWS ? `Open calendar for ${d.open.length - MAX_ROWS} more` : 'Open calendar', cal));
}

function renderTickets(r) {
  const box = $('tickets');
  box.replaceChildren();
  $('tickets-count').textContent = '';
  const page = { kind: 'page', path: '/tickets' };
  if (!r) return box.append(note('Waiting for the first check'));
  if (!r.ok) return box.append(item([el('span', 'label', 'Tickets did not load, retrying next poll')], page));
  const d = r.data;
  if (!d.signedIn) {
    box.append(item([el('span', 'label', 'Sign in to g-command to see tickets')], { kind: 'page', path: '/login' }));
    return;
  }
  $('tickets-count').textContent = `${d.open.length} open`;
  if (d.open.length === 0) {
    box.append(item([el('span', 'label', 'No open tickets')], page));
    return;
  }
  for (const t of d.open.slice(0, MAX_ROWS)) {
    box.append(item([
      el('span', 'label', plain(t.title)),
      el('span', 'meta', t.project),
      badge(SEVERITY_BADGE[t.severity] || 'badge-plain', sentence(t.severity)),
    ], page));
  }
  if (d.open.length > MAX_ROWS) box.append(more(`${d.open.length - MAX_ROWS} more on the tickets page`, page));
}

function renderLocal(s) {
  const box = $('local');
  box.replaceChildren();
  const settings = { kind: 'settings' };
  const n = s.ntfy || {};
  const alerts = {
    live: [`Alerts live on ${n.topics === 1 ? '1 topic' : `${n.topics} topics`}`, 'badge-ok', 'Live'],
    connecting: ['Alerts connecting', 'badge-plain', 'Connecting'],
    retrying: ['Alerts reconnecting', 'badge-warn', 'Retrying'],
    off: ['Alerts off, add an ntfy topic in settings', 'badge-plain', 'Off'],
  }[n.status] || ['Alerts state unknown', 'badge-plain', 'Unknown'];
  box.append(item([el('span', 'label', alerts[0]), badge(alerts[1], alerts[2])], settings));
  const g = s.genvMac || {};
  if (g.available) {
    const row = item([el('span', 'label', g.summary || 'g-env-mac linked'), badge(g.ok ? 'badge-ok' : 'badge-warn', g.ok ? 'Linked' : 'Error')], null);
    if (g.output) row.dataset.tip = g.output.split('\n').slice(0, 12).join('\n');
    box.append(row);
  } else {
    box.append(item([el('span', 'label', 'g-env-mac not linked on this device'), badge('badge-plain', 'Absent')], settings));
  }
}

function render(s) {
  if (!s) return;
  $('server').textContent = s.server ? `${s.server.name}, ${new URL(s.server.url).host}` : '';
  renderHealth(s.health);
  renderToday(s.today);
  renderTickets(s.tickets);
  renderLocal(s);
  if (s.at) {
    const t = new Date(s.at);
    $('updated').textContent = `Updated ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

$('refresh').addEventListener('click', async () => render(await window.gcm.refresh()));
$('open').addEventListener('click', () => window.gcm.open({ kind: 'page', path: '/' }));
window.gcm.onState(render);
window.gcm.state().then(render);
