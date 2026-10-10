'use strict';

// Decides which g-command-web page a notification opens. Order: the message's own
// Click URL (the sender knows best), then the user's rules from config, then
// the defaults below, which match what the spine's senders emit today:
// g-brain/outlets/remind.py titles its pings "Reminder", "Vital reminder"
// and "Catching up (n)"; brain_status.py titles them with the service or
// dependency id; g-admin tickets have no ntfy sender yet.

const DEFAULT_RULES = [
  { title: '^(vital reminder|reminder|catching up)', path: '/calendar' },
  { title: 'ticket', path: '/tickets' },
  { tags: 'rotating_light|warning', path: '/system' },
];

function test(pattern, value) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(value || '');
  } catch {
    return false;
  }
}

function matches(rule, msg) {
  if (!rule || typeof rule.path !== 'string') return false;
  if (!rule.title && !rule.tags && !rule.message && !rule.topic) return false;
  return (
    test(rule.title, msg.title) &&
    test(rule.message, msg.message) &&
    test(rule.topic, msg.topic) &&
    test(rule.tags, (msg.tags || []).join(','))
  );
}

// Returns { kind: 'app', server, url } for a page inside a configured server,
// or { kind: 'external', url } for anything else worth opening.
function route(msg, config) {
  if (msg.click) {
    const server = config.serverForUrl(msg.click);
    if (server) return { kind: 'app', server, url: msg.click };
    if (/^https?:\/\//i.test(msg.click)) return { kind: 'external', url: msg.click };
  }
  const server = config.centralServer;
  const rules = [...(config.data.routes || []), ...DEFAULT_RULES];
  const hit = rules.find((r) => matches(r, msg));
  const p = hit ? hit.path : '/';
  return { kind: 'app', server, url: new URL(p, server.url).toString() };
}

module.exports = { route, DEFAULT_RULES };
