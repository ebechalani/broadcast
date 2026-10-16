'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Campaign, sanitizeSettings, quietHoursRemainingMs, estimateDurationMs } = require('../src/campaign');

function fakeClient(options) {
  const o = options || {};
  const client = {
    ready: o.ready !== false,
    sent: [],
    checks: [],
    isReady() { return this.ready; },
    async resolveChatId(digits) {
      this.checks.push(digits);
      if (o.notRegistered && o.notRegistered.includes(digits)) return null;
      return `${digits}@c.us`;
    },
    async sendText(chatId, text) {
      if (o.failFor && o.failFor.includes(chatId)) throw new Error('boom');
      if (o.failTimes && o.failTimes[chatId] > 0) { o.failTimes[chatId]--; throw new Error('transient'); }
      this.sent.push({ chatId, text });
      return { id: `msg${this.sent.length}` };
    },
  };
  return client;
}

function fakeCounter(initial) {
  return { n: initial || 0, sentToday() { return this.n; }, increment() { this.n++; } };
}

const contacts = [
  { id: 'c1', firstName: 'Jean', lastName: 'Dupont', phone: '96170000001', e164: '+96170000001', extra: { Classe: '6B' } },
  { id: 'c2', firstName: 'Marie', lastName: 'Curie', phone: '96170000002', e164: '+96170000002', extra: {} },
  { id: 'c3', firstName: 'Ali', lastName: 'Hassan', phone: '96170000003', e164: '+96170000003', extra: {} },
];
const fast = { minDelaySec: 0.01, maxDelaySec: 0.02, batchSize: 100, batchPauseSec: 0, simulateTyping: false };

test('sends a personalized message to every contact and finishes', async () => {
  const client = fakeClient();
  const counter = fakeCounter();
  const c = new Campaign({ template: 'Hi {{firstName}} {{lastName}} ({{classe|none}})', contacts, settings: fast, client, counter });
  const states = [];
  c.on('state', s => states.push(s.state));
  await c.start();
  assert.equal(c.state, 'done');
  assert.deepEqual(client.sent.map(s => s.text), ['Hi Jean Dupont (6B)', 'Hi Marie Curie (none)', 'Hi Ali Hassan (none)']);
  assert.deepEqual(client.sent.map(s => s.chatId), ['96170000001@c.us', '96170000002@c.us', '96170000003@c.us']);
  assert.equal(counter.n, 3);
  assert.equal(c.counts().sent, 3);
  assert.ok(states.includes('running') && states.at(-1) === 'done');
  assert.ok(c.items.every(i => i.messageId));
});

test('numbers that are not on WhatsApp are skipped without counting as failures', async () => {
  const client = fakeClient({ notRegistered: ['96170000002'] });
  const c = new Campaign({ template: 'x', contacts, settings: fast, client });
  await c.start();
  assert.equal(c.counts().sent, 2);
  assert.equal(c.counts().notOnWhatsApp, 1);
  assert.equal(c.items[1].status, 'not_on_whatsapp');
});

test('checkRegistered=false sends directly to the c.us id', async () => {
  const client = fakeClient();
  const c = new Campaign({ template: 'x', contacts: contacts.slice(0, 1), settings: { ...fast, checkRegistered: false }, client });
  await c.start();
  assert.deepEqual(client.checks, []);
  assert.equal(client.sent[0].chatId, '96170000001@c.us');
});

test('transient failure is retried once, permanent failure is recorded', async () => {
  const client = fakeClient({ failTimes: { '96170000001@c.us': 1 }, failFor: ['96170000003@c.us'] });
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, maxRetries: 1, maxConsecutiveFailures: 10 }, client });
  await c.start();
  assert.equal(c.items[0].status, 'sent');
  assert.equal(c.items[0].attempts, 2);
  assert.equal(c.items[2].status, 'failed');
  assert.equal(c.items[2].attempts, 2);
  assert.equal(c.items[2].error, 'boom');
  assert.equal(c.state, 'done');
});

test('too many consecutive failures pauses the campaign', async () => {
  const client = fakeClient({ failFor: ['96170000001@c.us', '96170000002@c.us', '96170000003@c.us'] });
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, maxRetries: 0, maxConsecutiveFailures: 2 }, client });
  const loop = c.start();
  await waitFor(() => c.state === 'paused');
  assert.match(c.pauseReason, /2 failures in a row/);
  assert.equal(c.autoPaused, false);
  c.stop();
  await loop;
  assert.equal(c.state, 'stopped');
  assert.equal(c.items[2].status, 'pending');
});

test('pause and resume, and stop ends the loop', async () => {
  const client = fakeClient();
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, minDelaySec: 0.2, maxDelaySec: 0.2 }, client });
  const loop = c.start();
  await waitFor(() => client.sent.length === 1);
  c.pause('test');
  assert.equal(c.state, 'paused');
  await sleep(300);
  assert.equal(client.sent.length, 1, 'nothing is sent while paused');
  c.resume();
  await waitFor(() => client.sent.length === 2);
  c.stop();
  await loop;
  assert.equal(c.state, 'stopped');
  assert.equal(client.sent.length, 2);
  assert.equal(c.counts().pending, 1);
});

test('pauses automatically when WhatsApp is not connected and resumes when it is back', async () => {
  const client = fakeClient({ ready: false });
  const c = new Campaign({ template: 'x', contacts: contacts.slice(0, 1), settings: fast, client });
  const loop = c.start();
  await waitFor(() => c.state === 'paused');
  assert.equal(c.autoPaused, true);
  client.ready = true;
  c.resume();
  await loop;
  assert.equal(c.state, 'done');
});

test('daily limit stops sending for the day', async () => {
  const client = fakeClient();
  const counter = fakeCounter(0);
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, dailyLimit: 2 }, client, counter });
  const loop = c.start();
  await waitFor(() => c.waiting && c.waiting.label === 'daily limit reached');
  assert.equal(client.sent.length, 2);
  c.stop();
  await loop;
});

test('batch pause happens after batchSize messages', async () => {
  const client = fakeClient();
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, batchSize: 2, batchPauseSec: 0.3 }, client });
  const labels = [];
  c.on('state', s => { if (s.waiting) labels.push(s.waiting.label); });
  await c.start();
  assert.ok(labels.includes('batch pause'), `labels: ${labels.join(',')}`);
  assert.equal(client.sent.length, 3);
});

test('serialises and restores with in-flight items back to pending', async () => {
  const client = fakeClient();
  const c = new Campaign({ template: 'Hello {{firstName}}', contacts, settings: fast, client });
  c.items[0].status = 'sent';
  c.items[1].status = 'sending';
  c.state = 'running';
  const json = JSON.parse(JSON.stringify(c.toJSON()));
  assert.equal(json.state, 'paused');
  const restored = Campaign.fromJSON(json, { client });
  assert.equal(restored.state, 'paused');
  assert.equal(restored.items[1].status, 'pending');
  assert.equal(restored.template, 'Hello {{firstName}}');
  await restored.start();
  assert.equal(restored.state, 'done');
  assert.equal(client.sent.length, 2);
});

test('retryFailed re-queues failed items', async () => {
  const client = fakeClient({ failFor: ['96170000002@c.us'] });
  const c = new Campaign({ template: 'x', contacts, settings: { ...fast, maxRetries: 0, maxConsecutiveFailures: 10 }, client });
  await c.start();
  assert.equal(c.items[1].status, 'failed');
  client.sent = [];
  delete client.failFor;
  const n = c.retryFailed();
  assert.equal(n, 1);
  assert.equal(c.state, 'paused');
});

test('sanitizeSettings clamps and fixes ordering', () => {
  const s = sanitizeSettings({ minDelaySec: '1', maxDelaySec: '0', batchSize: 'abc', dailyLimit: 99999, checkRegistered: 'false', quietStart: '25:00' });
  assert.equal(s.minDelaySec, 3);
  assert.equal(s.maxDelaySec, 3);
  assert.equal(s.batchSize, 20);
  assert.equal(s.dailyLimit, 5000);
  assert.equal(s.checkRegistered, false);
  assert.equal(s.quietStart, '21:00');
});

test('quiet hours across midnight', () => {
  const s = { quietHoursEnabled: true, quietStart: '21:00', quietEnd: '08:00' };
  const at = (h, m) => { const d = new Date(2026, 0, 10, h, m, 0, 0); return d.getTime(); };
  assert.equal(quietHoursRemainingMs(s, at(12, 0)), 0);
  assert.ok(quietHoursRemainingMs(s, at(22, 0)) > 9 * 3600 * 1000);
  assert.ok(Math.abs(quietHoursRemainingMs(s, at(7, 0)) - 3600 * 1000) < 1000);
  assert.equal(quietHoursRemainingMs({ ...s, quietHoursEnabled: false }, at(22, 0)), 0);
  assert.equal(quietHoursRemainingMs({ quietHoursEnabled: true, quietStart: '13:00', quietEnd: '14:00' }, at(13, 30)) > 0, true);
});

test('estimateDurationMs grows with count and batch pauses', () => {
  const s = { minDelaySec: 30, maxDelaySec: 30, batchSize: 10, batchPauseSec: 60, simulateTyping: false };
  assert.equal(estimateDurationMs(0, s), 0);
  assert.equal(estimateDurationMs(1, s), 500);
  assert.equal(estimateDurationMs(11, s), 10 * 30000 + 11 * 500 + 60000);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}
