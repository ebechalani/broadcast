'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const config = require('./src/config');
const { parseContacts } = require('./src/contacts');
const { render, unknownPlaceholders } = require('./src/template');
const { Campaign, DEFAULT_SETTINGS, sanitizeSettings, estimateDurationMs } = require('./src/campaign');
const { JsonFile, DailyCounter, CampaignStore } = require('./src/store');
const WhatsApp = require('./src/whatsapp');

fs.mkdirSync(config.dataDir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ----- state -----
const settingsFile = new JsonFile(path.join(config.dataDir, 'settings.json'));
function loadSettings() {
  const saved = settingsFile.read({}) || {};
  const country = String(saved.defaultCountry || config.defaultCountry).toUpperCase();
  return { ...sanitizeSettings(saved), defaultCountry: /^[A-Z]{2}$/.test(country) ? country : 'LB' };
}
let settings = loadSettings();
const counter = new DailyCounter(path.join(config.dataDir, 'daily-counts.json'));
const campaigns = new CampaignStore(path.join(config.dataDir, 'campaigns'));
const wa = new WhatsApp({
  dataPath: path.join(config.dataDir, 'wa-session'),
  executablePath: config.chromePath || undefined,
  headless: config.headless,
});

let campaign = null;
let waState = { ...wa.snapshot(), qrDataUrl: null };
let shuttingDown = false;
const serverLogs = [];

function log(level, message, source) {
  const entry = { ts: Date.now(), level, message, source: source || 'app' };
  serverLogs.push(entry);
  if (serverLogs.length > 500) serverLogs.shift();
  const line = `[${new Date(entry.ts).toLocaleTimeString()}] ${level.toUpperCase().padEnd(7)} ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
  io.emit('log', entry);
}

// ----- request guard -----
// The server only listens on 127.0.0.1, but any website open in the user's
// browser could still send requests to localhost, and a DNS-rebound page could
// even read the answers. Browsers attach Origin / Sec-Fetch-Site headers to
// such requests, so every API and socket request must look like it comes from
// our own page.
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
if (config.port === 80 || config.port === 443) ['127.0.0.1', 'localhost', '[::1]'].forEach(h => allowedHosts.add(h));
function isAllowedOrigin(origin) {
  try { return allowedHosts.has(new URL(origin).host.toLowerCase()); } catch { return false; }
}
function isAllowedRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// ----- http + sockets -----
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  allowRequest: (req, callback) => {
    const ok = isAllowedRequest(req);
    callback(ok ? null : 'Forbidden', ok);
  },
});
io.engine.use((req, res, next) => {
  if (isAllowedRequest(req)) return next();
  res.writeHead(403);
  res.end();
});

app.disable('x-powered-by');
app.use('/api', (req, res, next) => (isAllowedRequest(req) ? next() : res.status(403).json({ error: 'Forbidden' })));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

function fullState() {
  return {
    wa: waState,
    campaign: campaign ? campaign.snapshot() : null,
    settings,
    defaults: DEFAULT_SETTINGS,
    sentToday: counter.sentToday(),
    logs: serverLogs.slice(-200),
    version: require('./package.json').version,
  };
}

io.on('connection', socket => {
  socket.emit('state', fullState());
});

// ----- WhatsApp events + bounded auto-reconnect -----
const RECONNECT_DELAYS_SEC = [15, 30, 60, 120, 300];
let reconnect = { attempt: 0, timer: null };

function cancelReconnect(resetAttempts) {
  if (reconnect.timer) clearTimeout(reconnect.timer);
  reconnect.timer = null;
  if (resetAttempts) reconnect.attempt = 0;
}

function scheduleReconnect() {
  if (reconnect.timer || shuttingDown) return;
  if (reconnect.attempt >= RECONNECT_DELAYS_SEC.length) {
    log('warn', 'Gave up reconnecting automatically. Click Connect to try again.');
    return;
  }
  const delay = RECONNECT_DELAYS_SEC[reconnect.attempt++];
  log('info', `Will try to reconnect in ${delay} s (attempt ${reconnect.attempt} of ${RECONNECT_DELAYS_SEC.length})`);
  reconnect.timer = setTimeout(() => {
    reconnect.timer = null;
    if (wa.client || wa.manualDisconnect || shuttingDown) return;
    wa.connect().catch(err => log('error', `Reconnect failed: ${err.message}`));
  }, delay * 1000);
}

wa.on('log', e => log(e.level, e.message, 'whatsapp'));
wa.on('status', async snap => {
  const next = { ...snap, qrDataUrl: null };
  if (snap.qr) {
    try { next.qrDataUrl = await QRCode.toDataURL(snap.qr, { margin: 1, width: 300, errorCorrectionLevel: 'M' }); } catch (err) { log('error', `QR render failed: ${err.message}`); }
  }
  waState = next;
  io.emit('wa', waState);

  if (snap.status === 'ready') cancelReconnect(true);
  if (snap.status === 'disconnected' && !snap.manualDisconnect && snap.lastDisconnectReason !== 'LOGOUT' && wa.hasSavedSession()) {
    scheduleReconnect();
  }

  if (campaign) {
    if (snap.status === 'ready' && campaign.state === 'paused' && campaign.autoPaused) {
      log('info', 'WhatsApp is back, resuming the campaign');
      campaign.resume();
    } else if (snap.status !== 'ready' && campaign.state === 'running') {
      campaign.pause('WhatsApp disconnected', { auto: true });
    }
  }
});

// ----- campaign wiring -----
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (campaign) {
      try { campaigns.save(campaign); } catch (err) { log('error', `Could not save campaign: ${err.message}`); }
    }
  }, 300);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (campaign) { try { campaigns.save(campaign); } catch { /* ignore */ } }
}

function campaignEvent(snap) {
  return { ...snap, sentToday: counter.sentToday() };
}

function attachCampaign(c) {
  campaign = c;
  c.on('state', snap => io.emit('campaign', campaignEvent(snap)));
  c.on('item', payload => io.emit('campaign:item', { ...payload, sentToday: counter.sentToday() }));
  c.on('log', entry => io.emit('log', { ...entry, source: 'campaign' }));
  c.on('change', scheduleSave);
  io.emit('campaign', campaignEvent(c.snapshot()));
}

const restored = campaigns.latestUnfinished();
if (restored) {
  attachCampaign(Campaign.fromJSON(restored, { client: wa, counter }));
  const c = campaign.counts();
  log('info', `Found an unfinished campaign "${campaign.name}" (${c.pending} left${c.failed ? `, ${c.failed} to review` : ''}). Resume it from the Send panel.`);
}

/** Pause the campaign and wait for a message that is going out right now. */
async function quiesceCampaign(reason) {
  if (!campaign) return;
  if (campaign.state === 'running') campaign.pause(reason, { auto: false });
  try { await campaign.settle(15000); } catch { /* ignore */ }
  saveNow();
}

// ----- API -----
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  log('error', `${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
});
const fail = (status, message) => Object.assign(new Error(message), { status });

app.get('/api/state', (req, res) => res.json(fullState()));

app.get('/api/settings', (req, res) => res.json(settings));
app.put('/api/settings', wrap((req, res) => {
  const body = req.body || {};
  const clean = sanitizeSettings({ ...settings, ...body });
  const country = String(body.defaultCountry || settings.defaultCountry || config.defaultCountry).toUpperCase();
  settings = { ...clean, defaultCountry: /^[A-Z]{2}$/.test(country) ? country : settings.defaultCountry };
  settingsFile.write(settings);
  io.emit('settings', settings);
  res.json(settings);
}));

app.post('/api/wa/connect', wrap(async (req, res) => {
  cancelReconnect(true);
  if (!wa.client) wa.connect().catch(err => log('error', `connect: ${err.message}`));
  res.json({ ...wa.snapshot(), qrDataUrl: null });
}));
app.post('/api/wa/disconnect', wrap(async (req, res) => {
  cancelReconnect(true);
  await quiesceCampaign('WhatsApp disconnected by user');
  await wa.disconnect();
  res.json(waState);
}));
app.post('/api/wa/logout', wrap(async (req, res) => {
  cancelReconnect(true);
  await quiesceCampaign('WhatsApp unlinked by user');
  await wa.logout();
  res.json(waState);
}));

app.post('/api/contacts/parse', upload.single('file'), wrap((req, res) => {
  const body = req.body || {};
  let mapping = null;
  if (body.mapping) { try { mapping = JSON.parse(body.mapping); } catch { mapping = null; } }
  const hasHeader = body.hasHeader === 'true' ? true : body.hasHeader === 'false' ? false : null;
  const defaultCountry = String(body.defaultCountry || settings.defaultCountry || 'LB').toUpperCase();
  const input = req.file
    ? { buffer: req.file.buffer, filename: req.file.originalname }
    : { text: String(body.text || '') };
  if (!req.file && !input.text.trim()) throw fail(400, 'Upload a file or paste some rows first');
  res.json(parseContacts(input, { defaultCountry, mapping, hasHeader }));
}));

app.post('/api/preview', wrap((req, res) => {
  const { template, contact, extraColumns } = req.body || {};
  const out = render(template || '', contact || {});
  res.json({ ...out, unknown: unknownPlaceholders(template || '', extraColumns || []) });
}));

app.post('/api/estimate', wrap((req, res) => {
  const { count, settings: s } = req.body || {};
  res.json({ ms: estimateDurationMs(Number(count) || 0, sanitizeSettings(s)) });
}));

app.post('/api/campaign/start', wrap((req, res) => {
  const body = req.body || {};
  if (campaign && (campaign.state === 'running' || campaign.state === 'paused' || campaign.state === 'idle')) {
    throw fail(409, 'A campaign is already in progress. Stop or discard it first.');
  }
  if (campaign && campaign.counts().sending > 0) throw fail(409, 'A message is still being sent. Try again in a few seconds.');
  if (!wa.isReady()) throw fail(400, 'Connect WhatsApp first');
  const template = String(body.template || '').trim();
  if (!template) throw fail(400, 'The message is empty');
  const contacts = (Array.isArray(body.contacts) ? body.contacts : []).filter(c => c && c.status === 'ok' && c.phone);
  if (!contacts.length) throw fail(400, 'No valid contacts to send to');
  const campaignSettings = sanitizeSettings({ ...settings, ...(body.settings || {}) });
  if (campaign) campaign.removeAllListeners();
  const c = new Campaign({ name: body.name, template, contacts, settings: campaignSettings, client: wa, counter });
  attachCampaign(c);
  saveNow();
  c.start().catch(err => log('error', `Campaign loop ended with error: ${err.message}`));
  log('info', `Campaign "${c.name}" started with ${contacts.length} contact(s)`);
  res.json(c.snapshot());
}));

app.post('/api/campaign/pause', wrap((req, res) => {
  if (!campaign) throw fail(404, 'No campaign');
  campaign.pause('Paused by user');
  res.json(campaign.snapshot({ items: false }));
}));
app.post('/api/campaign/resume', wrap((req, res) => {
  if (!campaign) throw fail(404, 'No campaign');
  if (!wa.isReady()) throw fail(400, 'Connect WhatsApp first');
  campaign.resume();
  res.json(campaign.snapshot({ items: false }));
}));
app.post('/api/campaign/stop', wrap((req, res) => {
  if (!campaign) throw fail(404, 'No campaign');
  campaign.stop();
  saveNow();
  res.json(campaign.snapshot({ items: false }));
}));
app.post('/api/campaign/retry-failed', wrap((req, res) => {
  if (!campaign) throw fail(404, 'No campaign');
  const body = req.body || {};
  const n = campaign.retryFailed({ includeNotOnWhatsApp: body.includeNotOnWhatsApp === true });
  // Only resume when the page asked for it (the user confirmed), never silently from a manual pause.
  if (n && body.resume === true && wa.isReady()) campaign.resume();
  res.json({ requeued: n, campaign: campaign.snapshot({ items: false }) });
}));
app.post('/api/campaign/discard', wrap((req, res) => {
  if (!campaign) return res.json({ ok: true });
  if (campaign.state === 'running') throw fail(409, 'Pause or stop the campaign first');
  if (campaign.counts().sending > 0) throw fail(409, 'A message is still being sent. Try again in a few seconds.');
  if (campaign.state !== 'done') campaign.stop();
  saveNow();
  campaign.removeAllListeners();
  campaign = null;
  io.emit('campaign', null);
  res.json({ ok: true });
}));
app.post('/api/campaign/test', wrap(async (req, res) => {
  if (!wa.isReady()) throw fail(400, 'Connect WhatsApp first');
  if (campaign && (campaign.state === 'running' || campaign.counts().sending > 0)) throw fail(409, 'Pause the campaign before sending a test');
  const { template, contact } = req.body || {};
  const sample = contact || { firstName: 'Test', lastName: 'Contact', phone: wa.info && wa.info.number, extra: {} };
  const { text } = render(String(template || ''), sample);
  if (!text.trim()) throw fail(400, 'The message is empty');
  const result = await wa.sendToSelf(`[Test message]\n\n${text}`);
  log('info', 'Test message sent to your own number');
  res.json({ ok: true, text, id: result.id });
}));

app.get('/api/campaign/export.csv', wrap((req, res) => {
  if (!campaign) throw fail(404, 'No campaign');
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fixed = ['firstName', 'lastName', 'phone', 'status', 'error', 'sentAt'];
  const extraKeys = [];
  for (const it of campaign.items) for (const k of Object.keys(it.extra || {})) if (!extraKeys.includes(k)) extraKeys.push(k);
  const extraHead = extraKeys.map(k => (fixed.includes(k) ? `${k} (column)` : k));
  const lines = [[...fixed, ...extraHead].join(',')];
  for (const it of campaign.items) {
    lines.push([
      it.firstName, it.lastName, it.e164 || it.phone, it.status, it.error || '',
      it.sentAt ? new Date(it.sentAt).toISOString() : '',
      ...extraKeys.map(k => (it.extra || {})[k]),
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="broadcast-${campaign.id}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}));

app.get('/api/sample.csv', (req, res) => res.sendFile(path.join(__dirname, 'samples', 'contacts-sample.csv')));
app.use('/samples', express.static(path.join(__dirname, 'samples')));

// Express 5 error handler (multer errors, bad JSON, ...)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', `${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 400).json({ error: err.message });
});

// ----- start -----
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Is WhatsApp Broadcast already running in another window?`);
    console.error(`  Close it, or start this one with a different port: PORT=3211 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log(`  WhatsApp Broadcast is running at ${url}`);
  console.log(`  Data folder: ${config.dataDir}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (config.openBrowser) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => { /* ignore */ });
  }
  if (wa.hasSavedSession()) {
    log('info', 'Saved WhatsApp session found, reconnecting…');
    wa.connect().catch(err => log('error', `connect: ${err.message}`));
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down…`);
  cancelReconnect(true);
  try {
    if (campaign && campaign.state === 'running') campaign.pause('Application closed', { auto: false });
    if (campaign) await campaign.settle(10000); // let a message that is going out finish, so it is recorded
  } catch { /* ignore */ }
  saveNow();
  try { await Promise.race([wa.destroy(), sleep(8000)]); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', err => log('error', `Unhandled: ${err && err.message ? err.message : err}`));
