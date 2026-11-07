'use strict';

const $ = (id) => document.getElementById(id);
const plain = (s) => (window.g && g.plain ? g.plain(String(s || '')) : String(s || ''));


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

function note(text) {
  return el('div', 'note', text);
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

function clock(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

// Each button names what clicking does; the state sits beside it as detail.
function renderGenv(s) {
  const box = $('genv');
  const sticky = $('sticky');
  box.replaceChildren();
  sticky.replaceChildren();
  $('sticky-card').hidden = true;
  $('genv-count').textContent = '';
  const g = s.genvMac || {};
  if (!g.available) return box.append(note('genv not found on this device, set genvMac.path in settings'));
  if (!g.state) return box.append(note(g.summary || 'genv status did not answer, retrying next poll'));
  const procs = Object.entries(g.state.processes || {});
  const down = procs.filter(([, v]) => v !== 'up').map(([k]) => k);
  $('genv-count').textContent = down.length ? `${down.length} down` : `${procs.length} up`;
  if (down.length) box.append(note(`Down: ${down.join(', ')}`));
  for (const a of g.actions || []) {
    const into = a.group === 'sticky' ? sticky : box;
    if (into === sticky && !sticky.childElementCount) {
      $('sticky-card').hidden = false;
      sticky.append(note('Sticky apps follow you onto every workspace, leftmost first'));
    }
    const busy = g.busy === a.args.join(' ');
    const b = item([
      el('span', 'label', busy ? `${a.label}, running` : a.label),
      el('span', 'meta', a.enabled ? a.detail : a.why),
    ], null);
    b.classList.remove('static');
    b.disabled = !a.enabled || !!g.busy;
    b.dataset.tip = `${a.detail}. Runs genv ${a.args.join(' ')}`;
    b.addEventListener('click', async () => {
      const res = await window.gcm.genv(a.args);
      if (!res.ok && window.g && window.g.toast) window.g.toast({ kind: 'error', title: `genv ${a.args.join(' ')} did not finish`, desc: plain(res.output).slice(0, 160) || 'Status refreshed, try again' });
    });
    into.append(b);
  }
}

function renderRunner(s) {
  const box = $('runner');
  box.replaceChildren();
  const r = s.runner || {};
  const word = { up: ['Up', 'badge-ok'], loading: ['Loading', 'badge-plain'], restarting: ['Restarting', 'badge-warn'], off: ['Off', 'badge-plain'] }[r.state] || ['Unknown', 'badge-plain'];
  $('runner-count').textContent = r.device || '';
  const toggle = item([
    el('span', 'label', r.on ? 'Stop running jobs on this Mac' : 'Run jobs on this Mac'),
    badge(word[1], word[0]),
  ], null);
  toggle.classList.remove('static');
  toggle.addEventListener('click', async () => render(await window.gcm.setRunner(!r.on)));
  box.append(toggle);
  if (!r.on) return box.append(note(`Takes device-test jobs as ${r.device}, keeps the Mac awake`));
  const facts = [];
  if (r.lastLoad) facts.push(`Loaded ${clock(r.lastLoad)}`);
  if (r.lastCrash) facts.push(`restarted ${clock(r.lastCrash)}: ${plain(r.lastError)}`);
  box.append(note(facts.length ? facts.join(', ') : 'Loading the runner page'));
}

function render(s) {
  if (!s) return;
  renderGenv(s);
  renderRunner(s);
  renderLocal(s);
  if (s.at) {
    const t = new Date(s.at);
    $('updated').textContent = `Updated ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

$('refresh').addEventListener('click', async () => render(await window.gcm.refresh()));
window.gcm.onState(render);
window.gcm.state().then(render);
