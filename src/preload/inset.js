'use strict';

// The pool views' preload. INSET_CSS (main.js) lays the web's shell out under
// the traffic lights. Inserted at dom-ready it arrived after the new page's
// first frame, so on every page switch the brand painted one frame up by the
// traffic lights before dropping to its row. Inserted here, before the page
// parses, it is in place from the first frame.
const { ipcRenderer, webFrame } = require('electron');

try {
  const css = ipcRenderer.sendSync('gcm:inset-css', location.href);
  if (css) webFrame.insertCSS(css);
} catch (e) {}
