'use strict';

// The Mac page's rail item navigates the web page to MAC_PATH with the content
// area's rect in the query; main.js catches that navigation. Pure helpers so
// the parsing is testable without Electron.

const MAC_PATH = '/__gcm/mac';

function isMacUrl(server, url) {
  try {
    const u = new URL(url);
    return u.origin === server.url && u.pathname === MAC_PATH;
  } catch {
    return false;
  }
}

// The rect comes from a web page, so it is clamped to the window before use.
function clampRect(url, { width, height }) {
  const q = new URL(url).searchParams;
  const n = (k, d) => {
    const v = q.get(k);
    return v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : d;
  };
  const x = Math.min(Math.max(n('x', 0), 0), width - 1);
  const y = Math.min(Math.max(n('y', 0), 0), height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(n('w', width), width - x)),
    height: Math.max(1, Math.min(n('h', height), height - y)),
  };
}

module.exports = { MAC_PATH, isMacUrl, clampRect };
