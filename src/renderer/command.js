'use strict';

// The g-admin bar links its ticket count and "Command centre" to the origin in
// <meta name="g-command">. main.js passes the central server from config.json
// as ?command=, so no host is written into these pages. This runs before the
// deferred g-ui.js, whose stub is what loads the bar.
document.querySelector('meta[name="g-command"]').content =
  new URLSearchParams(location.search).get('command') || '';
