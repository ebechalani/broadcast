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

// ----- state -----
const settingsFile = new JsonFile(path.join(config.dataDir, 'settings.json'));
let settings = { ...DEFAULT_SETTINGS, defaultCountry: config.defaultCountry, ...settingsFile.read({}) };
const counter = new DailyCounter(path.join(config.dataDir, 'daily-counts.json'));
const campaigns = new CampaignStore(path.join(config.dataDir, 'campaigns'));
const wa = new WhatsApp({
  dataPath: path.join(config.dataDir, 'wa-session'),
  executablePath: config.chromePath || undefined,
  headless: config.headless,
});

let campaign = null;
let waState = { ...wa.snapshot(), qrDataUrl: null };
const serverLogs = [];

function log(level, message, source) {
  const entry = { ts: Date.now(), level, message, source: source || 'app' };
  serverLogs.push(entry);
  if (serverLogs.length > 500) serverLogs.shift();
  const line = `[${new Date(entry.ts).toLocaleTimeString()}] ${level.toUpperCase().padEnd(7)} ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
  io.emit('log', entry);
}

// ----- http + sockets -----
// The server only listens on 127.0.0.1, but any website open in the user's browser
// could still send requests to localhost. Browsers attach an Origin header to such
// cross-site requests (and to WebSocket upgrades), so we only accept our own origin.
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
function isAllowedOrigin(origin) {
  try { return allowedHosts.has(new URL(origin).host.toLowerCase()); } catch { return false; }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    const ok = !origin || isAllowedOrigin(origin);
    callback(ok ? null : 'Forbidden origin', ok);
  },
});

app.disable('x-powered-by');
app.use('/api', (req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts.has(host)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return res.status(403).json({ error: 'Forbidden' });
  return next();
});
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

// ----- WhatsApp events -----
wa.on('log', e => log(e.level, e.message, 'whatsapp'));
wa.on('status', async snap => {
  const next = { ...snap, qrDataUrl: null };
  if (snap.qr) {
    try { next.qrDataUrl = await QRCode.toDataURL(snap.qr, { margin: 1, width: 300, errorCorrectionLevel: 'M' }); } catch (err) { log('error', `QR render failed: ${err.message}`); }
  }
  waState = next;
  io.emit('wa', waState);

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
  }, 400);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (campaign) { try { campaigns.save(campaign); } catch { /* ignore */ } }
}

function attachCampaign(c) {
  campaign = c;
  c.on('state', snap => io.emit('campaign', snap));
  c.on('item', payload => io.emit('campaign:item', payload));
  c.on('log', entry => io.emit('log', { ...entry, source: 'campaign' }));
  c.on('change', scheduleSave);
  io.emit('campaign', c.snapshot());
}

const restored = campaigns.latestUnfinished();
if (restored) {
  attachCampaign(Campaign.fromJSON(restored, { client: wa, counter }));
  log('info', `Found an unfinished campaign "${campaign.name}" (${campaign.counts().pending} left). Resume it from the Send panel.`);
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
  settings = { ...clean, defaultCountry: /^[A-Z]{2}$/.test(country) ? country : config.defaultCountry };
  settingsFile.write(settings);
  io.emit('settings', settings);
  res.json(settings);
}));

app.post('/api/wa/connect', wrap(async (req, res) => {
  if (wa.client) return res.json(waState);
  wa.connect().catch(err => log('error', `connect: ${err.message}`));
  res.json({ ...wa.snapshot(), qrDataUrl: null });
}));
app.post('/api/wa/disconnect', wrap(async (req, res) => {
  if (campaign && campaign.state === 'running') campaign.pause('WhatsApp disconnected by user');
  await wa.disconnect();
  res.json(waState);
}));
app.post('/api/wa/logout', wrap(async (req, res) => {
  if (campaign && campaign.state === 'running') campaign.pause('WhatsApp unlinked by user');
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
  const result = parseContacts(input, { defaultCountry, mapping, hasHeader });
  res.json(result);
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
  if (!wa.isReady()) throw fail(400, 'Connect WhatsApp first');
  const template = String(body.template || '').trim();
  if (!template) throw fail(400, 'The message is empty');
  const contacts = (Array.isArray(body.contacts) ? body.contacts : []).filter(c => c && c.status === 'ok' && c.phone);
  if (!contacts.length) throw fail(400, 'No valid contacts to send to');
  const campaignSettings = sanitizeSettings({ ...settings, ...(body.settings || {}) });
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
  const n = campaign.retryFailed();
  if (n && wa.isReady()) campaign.resume();
  res.json({ requeued: n, campaign: campaign.snapshot({ items: false }) });
}));
app.post('/api/campaign/discard', wrap((req, res) => {
  if (!campaign) return res.json({ ok: true });
  if (campaign.state === 'running') throw fail(409, 'Pause or stop the campaign first');
  if (campaign.state !== 'done') campaign.stop();
  saveNow();
  campaign.removeAllListeners();
  campaign = null;
  io.emit('campaign', null);
  res.json({ ok: true });
}));
app.post('/api/campaign/test', wrap(async (req, res) => {
  if (!wa.isReady()) throw fail(400, 'Connect WhatsApp first');
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
  const extraKeys = [];
  for (const it of campaign.items) for (const k of Object.keys(it.extra || {})) if (!extraKeys.includes(k)) extraKeys.push(k);
  const head = ['firstName', 'lastName', 'phone', 'status', 'error', 'sentAt', ...extraKeys];
  const lines = [head.join(',')];
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

// Express 5 error handler (multer errors, bad JSON, ...)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log('error', `${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 400).json({ error: err.message });
});

// ----- start -----
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down…`);
  try { if (campaign && campaign.state === 'running') campaign.pause('Application closed'); } catch { /* ignore */ }
  saveNow();
  try { await Promise.race([wa.destroy(), new Promise(r => setTimeout(r, 5000))]); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', err => log('error', `Unhandled: ${err && err.message ? err.message : err}`));
