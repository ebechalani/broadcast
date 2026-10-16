'use strict';
const EventEmitter = require('events');
const crypto = require('crypto');
const { render } = require('./template');

// Conservative defaults for a personal number. See README "Staying safe".
const DEFAULT_SETTINGS = Object.freeze({
  minDelaySec: 25,          // random pause between two messages: at least this
  maxDelaySec: 60,          // ... and at most this
  batchSize: 20,            // after this many messages ...
  batchPauseSec: 300,       // ... pause this long (randomized +/-20%)
  dailyLimit: 150,          // never send more than this per calendar day (all campaigns)
  checkRegistered: true,    // skip numbers that are not on WhatsApp instead of failing
  simulateTyping: true,     // show "typing..." for a moment before each message
  quietHoursEnabled: false, // do not send between quietStart and quietEnd
  quietStart: '21:00',
  quietEnd: '08:00',
  maxRetries: 1,            // retry a failed send this many times
  maxConsecutiveFailures: 3 // pause the campaign after this many failures in a row
});

const LIMITS = {
  minDelaySec: [3, 3600],
  maxDelaySec: [3, 7200],
  batchSize: [1, 1000],
  batchPauseSec: [0, 86400],
  dailyLimit: [1, 5000],
  maxRetries: [0, 5],
  maxConsecutiveFailures: [1, 50],
};

function sanitizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = src[key];
    if (v === undefined || v === null || v === '') continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = LIMITS[key] || [-Infinity, Infinity];
      out[key] = Math.min(hi, Math.max(lo, Math.round(n)));
    } else if (typeof def === 'boolean') {
      out[key] = v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
    } else {
      out[key] = String(v);
    }
  }
  if (out.maxDelaySec < out.minDelaySec) out.maxDelaySec = out.minDelaySec;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.quietStart)) out.quietStart = DEFAULT_SETTINGS.quietStart;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.quietEnd)) out.quietEnd = DEFAULT_SETTINGS.quietEnd;
  return out;
}

const randomBetween = (min, max) => min + Math.random() * (max - min);
const jitter = (ms, ratio) => ms * (1 + randomBetween(-ratio, ratio));

/** How long "typing..." is shown for a message of this length (ms). */
function typingDuration(text) {
  const base = 1200 + String(text || '').length * 35;
  return Math.round(Math.min(8000, jitter(base, 0.25)));
}

function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/** Milliseconds until quiet hours end, or 0 if we are outside them. */
function quietHoursRemainingMs(settings, nowTs) {
  if (!settings.quietHoursEnabled) return 0;
  const start = minutesOfDay(settings.quietStart);
  const end = minutesOfDay(settings.quietEnd);
  if (start === end) return 0;
  const d = new Date(nowTs);
  const cur = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const inQuiet = start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  if (!inQuiet) return 0;
  const endToday = new Date(d);
  endToday.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (endToday.getTime() <= nowTs) endToday.setDate(endToday.getDate() + 1);
  return endToday.getTime() - nowTs;
}

function msUntilMidnight(nowTs) {
  const d = new Date(nowTs);
  const next = new Date(d);
  next.setHours(24, 0, 5, 0); // a few seconds past midnight
  return next.getTime() - nowTs;
}

/** Rough duration estimate for n messages with these settings (ms). */
function estimateDurationMs(n, settings) {
  if (!n) return 0;
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const avgDelay = ((s.minDelaySec + s.maxDelaySec) / 2) * 1000;
  const typing = s.simulateTyping ? 3500 : 500;
  const batches = s.batchSize > 0 ? Math.floor((n - 1) / s.batchSize) : 0;
  return (n - 1) * avgDelay + n * typing + batches * s.batchPauseSec * 1000;
}

function toItem(contact, index) {
  return {
    id: contact.id || `c${index + 1}`,
    firstName: contact.firstName || '',
    lastName: contact.lastName || '',
    phone: String(contact.phone),
    e164: contact.e164 || `+${contact.phone}`,
    phoneDisplay: contact.phoneDisplay || contact.e164 || `+${contact.phone}`,
    extra: contact.extra && typeof contact.extra === 'object' ? contact.extra : {},
    status: 'pending',
    attempts: 0,
    error: null,
    sentAt: null,
    messageId: null,
    chatId: null,
  };
}

const TERMINAL = new Set(['done', 'stopped']);

/**
 * A campaign sends one rendered message per item, pacing itself according to
 * its settings. It emits:
 *   'state'  -> snapshot without items (state, counts, waiting, ...)
 *   'item'   -> { index, item } whenever one item changes
 *   'log'    -> { ts, level, message }
 *   'change' -> whenever something worth persisting changed
 *
 * `client` must provide isReady(), resolveChatId(digits) -> chatId|null and
 * sendText(chatId, text, { simulateTyping, typingMs }) -> { id }.
 * `counter` (optional) must provide sentToday() and increment().
 */
class Campaign extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.id = o.id || crypto.randomBytes(6).toString('hex');
    this.now = o.now || Date.now;
    this.createdAt = o.createdAt || this.now();
    this.name = o.name || `Campaign ${new Date(this.createdAt).toLocaleString()}`;
    this.template = String(o.template || '');
    this.settings = { ...DEFAULT_SETTINGS, ...(o.settings || {}) };
    this.client = o.client;
    this.counter = o.counter || null;
    this.items = Array.isArray(o.items) ? o.items : (o.contacts || []).map(toItem);
    this.logs = Array.isArray(o.logs) ? o.logs.slice(-500) : [];
    this.state = 'idle';
    this.pauseReason = null;
    this.autoPaused = false;
    this.waiting = null;
    this.startedAt = o.startedAt || null;
    this.finishedAt = o.finishedAt || null;
    this.lastSentAt = o.lastSentAt || null;
    this.sentSinceBatchPause = 0;
    this.consecutiveFailures = 0;
    this._waker = null;
    this._loopPromise = null;
    this._persistCount = 0;
  }

  // ----- lifecycle -----

  start() {
    if (this.state === 'running') return this._loopPromise;
    if (TERMINAL.has(this.state)) throw new Error(`Campaign is already ${this.state}`);
    const pending = this.counts().pending;
    if (!pending) {
      this._finish('done');
      return Promise.resolve();
    }
    const wasPaused = this.state === 'paused';
    this.state = 'running';
    this.pauseReason = null;
    this.autoPaused = false;
    if (!this.startedAt) this.startedAt = this.now();
    this._log('info', wasPaused ? `Resumed, ${pending} message(s) left` : `Started: ${pending} message(s) queued`);
    this._emitState();
    if (!this._loopPromise) {
      this._loopPromise = this._loop().finally(() => { this._loopPromise = null; });
    } else {
      this._wake();
    }
    return this._loopPromise;
  }

  resume() {
    return this.start();
  }

  pause(reason, options) {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.pauseReason = reason || 'Paused by user';
    this.autoPaused = Boolean(options && options.auto);
    this._log('warn', `Paused: ${this.pauseReason}`);
    this._emitState();
    this._wake();
  }

  stop() {
    if (TERMINAL.has(this.state)) return;
    const wasIdle = this.state === 'idle';
    this.state = 'stopped';
    this.pauseReason = null;
    this.autoPaused = false;
    this.finishedAt = this.now();
    this._log('warn', 'Stopped by user');
    this._emitState();
    this._wake();
    if (wasIdle) this.emit('change');
  }

  /** Put failed items back in the queue (does not resume by itself). */
  retryFailed() {
    let n = 0;
    this.items.forEach((item, index) => {
      if (item.status === 'failed') {
        item.status = 'pending';
        item.attempts = 0;
        item.error = null;
        n++;
        this.emit('item', { index, item });
      }
    });
    if (n) {
      if (TERMINAL.has(this.state)) { this.state = 'paused'; this.pauseReason = 'Ready to retry'; this.finishedAt = null; }
      this._log('info', `${n} failed message(s) queued again`);
      this._emitState();
    }
    return n;
  }

  // ----- main loop -----

  async _loop() {
    while (!TERMINAL.has(this.state)) {
      try {
        await this._step();
      } catch (err) {
        this._log('error', `Unexpected error: ${err && err.message ? err.message : err}`);
        if (this.state === 'running') this.pause(`Internal error: ${err && err.message ? err.message : err}`);
      }
    }
    this.waiting = null;
    this._emitState();
  }

  async _step() {
    if (this.state === 'paused') {
      await this._waitForWake();
      return;
    }
    if (this.state !== 'running') return;

    const index = this.items.findIndex(i => i.status === 'pending');
    if (index < 0) { this._finish('done'); return; }

    if (!this.client || !this.client.isReady()) {
      this.pause('WhatsApp is not connected', { auto: true });
      return;
    }

    const quietMs = quietHoursRemainingMs(this.settings, this.now());
    if (quietMs > 0) { await this._wait(quietMs, 'quiet hours'); return; }

    if (this.counter && this.counter.sentToday() >= this.settings.dailyLimit) {
      this._log('warn', `Daily limit of ${this.settings.dailyLimit} reached, waiting for tomorrow`);
      await this._wait(msUntilMidnight(this.now()), 'daily limit reached');
      return;
    }

    if (this.settings.batchSize > 0 && this.sentSinceBatchPause >= this.settings.batchSize) {
      this.sentSinceBatchPause = 0;
      if (this.settings.batchPauseSec > 0) {
        await this._wait(jitter(this.settings.batchPauseSec * 1000, 0.2), 'batch pause');
        return;
      }
    }

    // Never send two messages closer together than minDelay, even across pause/resume.
    if (this.lastSentAt) {
      const since = this.now() - this.lastSentAt;
      const minGap = this.settings.minDelaySec * 1000;
      if (since < minGap) { await this._wait(minGap - since, 'next message'); return; }
    }

    await this._sendItem(index);
    if (this.state !== 'running') return;

    if (this.items.some(i => i.status === 'pending')) {
      const delay = randomBetween(this.settings.minDelaySec, this.settings.maxDelaySec) * 1000;
      await this._wait(delay, 'next message');
    }
  }

  async _sendItem(index) {
    const item = this.items[index];
    item.status = 'sending';
    item.attempts += 1;
    item.error = null;
    this.emit('item', { index, item });

    const { text } = render(this.template, item);
    const who = `${item.firstName} ${item.lastName}`.trim() || item.phoneDisplay;
    try {
      let chatId = item.chatId;
      if (!chatId) {
        if (this.settings.checkRegistered) {
          chatId = await this.client.resolveChatId(item.phone);
          if (!chatId) {
            item.status = 'not_on_whatsapp';
            item.error = 'Number is not registered on WhatsApp';
            this.consecutiveFailures = 0;
            this._log('warn', `Skipped ${who} (${item.phoneDisplay}): not on WhatsApp`);
            this.emit('item', { index, item });
            this._emitState();
            return;
          }
        } else {
          chatId = `${item.phone}@c.us`;
        }
        item.chatId = chatId;
      }
      const result = await this.client.sendText(chatId, text, {
        simulateTyping: this.settings.simulateTyping,
        typingMs: typingDuration(text),
      });
      item.status = 'sent';
      item.sentAt = this.now();
      item.messageId = result && result.id ? result.id : null;
      this.lastSentAt = item.sentAt;
      this.sentSinceBatchPause += 1;
      this.consecutiveFailures = 0;
      if (this.counter) this.counter.increment();
      this._log('success', `Sent to ${who} (${item.phoneDisplay})`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      item.error = message;
      this.consecutiveFailures += 1;
      if (item.attempts <= this.settings.maxRetries) {
        item.status = 'pending';
        this._log('warn', `Failed for ${who}: ${message}. Will retry.`);
      } else {
        item.status = 'failed';
        this._log('error', `Failed for ${who}: ${message}`);
      }
      if (this.consecutiveFailures >= this.settings.maxConsecutiveFailures) {
        this.pause(`${this.consecutiveFailures} failures in a row. Check the WhatsApp connection before resuming.`);
      }
    }
    this.emit('item', { index, item });
    this._emitState();
  }

  _finish(state) {
    this.state = state;
    this.waiting = null;
    this.pauseReason = null;
    this.autoPaused = false;
    this.finishedAt = this.now();
    const c = this.counts();
    this._log('info', `Finished: ${c.sent} sent, ${c.failed} failed, ${c.notOnWhatsApp} not on WhatsApp`);
    this._emitState();
    this._wake();
  }

  // ----- waiting helpers -----

  _wait(ms, label) {
    const duration = Math.max(0, Math.round(ms));
    return new Promise(resolve => {
      const until = this.now() + duration;
      this.waiting = { label, until, ms: duration };
      this._emitState();
      let timer = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (this._waker === finish) this._waker = null;
        this.waiting = null;
        resolve();
      };
      this._waker = finish;
      timer = setTimeout(finish, duration);
    });
  }

  _waitForWake() {
    return new Promise(resolve => {
      const finish = () => {
        if (this._waker === finish) this._waker = null;
        resolve();
      };
      this._waker = finish;
    });
  }

  _wake() {
    const w = this._waker;
    if (w) w();
  }

  // ----- reporting -----

  counts() {
    const c = { total: this.items.length, pending: 0, sending: 0, sent: 0, failed: 0, notOnWhatsApp: 0 };
    for (const i of this.items) {
      if (i.status === 'pending') c.pending++;
      else if (i.status === 'sending') c.sending++;
      else if (i.status === 'sent') c.sent++;
      else if (i.status === 'failed') c.failed++;
      else if (i.status === 'not_on_whatsapp') c.notOnWhatsApp++;
    }
    c.done = c.sent + c.failed + c.notOnWhatsApp;
    return c;
  }

  snapshot(options) {
    const withItems = !options || options.items !== false;
    const snap = {
      id: this.id,
      name: this.name,
      state: this.state,
      pauseReason: this.pauseReason,
      autoPaused: this.autoPaused,
      waiting: this.waiting,
      counts: this.counts(),
      settings: this.settings,
      template: this.template,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastSentAt: this.lastSentAt,
      estimatedRemainingMs: estimateDurationMs(this.counts().pending, this.settings),
    };
    if (withItems) {
      snap.items = this.items;
      snap.logs = this.logs.slice(-300);
    }
    return snap;
  }

  toJSON() {
    const snap = this.snapshot({ items: false });
    delete snap.waiting;
    delete snap.estimatedRemainingMs;
    // A running campaign is saved as paused so it can be resumed after a restart.
    if (snap.state === 'running') { snap.state = 'paused'; snap.pauseReason = 'Interrupted'; }
    snap.items = this.items;
    snap.logs = this.logs.slice(-500);
    return snap;
  }

  static fromJSON(json, deps) {
    const d = deps || {};
    const items = (json.items || []).map(i => ({
      ...i,
      // A send that was in flight when the app stopped is retried.
      status: i.status === 'sending' ? 'pending' : i.status,
    }));
    const c = new Campaign({
      id: json.id,
      name: json.name,
      template: json.template,
      settings: json.settings,
      items,
      logs: json.logs,
      createdAt: json.createdAt,
      startedAt: json.startedAt,
      finishedAt: json.finishedAt,
      lastSentAt: json.lastSentAt,
      client: d.client,
      counter: d.counter,
      now: d.now,
    });
    if (json.state === 'done' || json.state === 'stopped') {
      c.state = json.state;
    } else if (items.some(i => i.status === 'pending')) {
      c.state = 'paused';
      c.pauseReason = json.pauseReason || 'Restored after restart';
    } else {
      c.state = 'done';
    }
    return c;
  }

  _log(level, message) {
    const entry = { ts: this.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    this.emit('log', entry);
  }

  _emitState() {
    this.emit('state', this.snapshot({ items: false }));
    this.emit('change');
  }
}

module.exports = {
  Campaign,
  DEFAULT_SETTINGS,
  LIMITS,
  sanitizeSettings,
  estimateDurationMs,
  quietHoursRemainingMs,
  msUntilMidnight,
  typingDuration,
};
