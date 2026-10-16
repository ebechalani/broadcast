'use strict';
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = process.env;

module.exports = {
  root,
  port: Number(env.PORT) || 3210,
  host: '127.0.0.1',
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(root, 'data'),
  // Leave empty to use the Chromium that whatsapp-web.js/puppeteer downloads.
  // Set CHROME_PATH to use an installed browser instead, e.g.
  // C:\Program Files\Google\Chrome\Application\chrome.exe
  chromePath: env.CHROME_PATH || '',
  // The automated Chrome window is visible by default: in 2026 several users report
  // headless logins stalling right after the QR scan. Set HEADLESS=true to hide it.
  headless: env.HEADLESS === 'true',
  openBrowser: env.OPEN_BROWSER !== 'false' && !process.argv.includes('--no-open'),
  defaultCountry: env.DEFAULT_COUNTRY || 'LB',
};
