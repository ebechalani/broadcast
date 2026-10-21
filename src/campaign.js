'use strict';
const EventEmitter = require('events');
const crypto = require('crypto');
const { render } = require('./template');

// Conservative defaults for a personal number. See README "Staying safe".
const DEFAULT_SETTINGS = Object.freeze({
  minDelaySec: 25,            // random pause between two messages: at least this
  maxDelaySec: 60,            // ... and at most this
  batchSize: 20,              // after this many messages ...
  batchPauseSec: 300,         // ... pause this long (randomized +/-20%)
  dailyLimit: 150,            // never send more than this per calendar day (all campaigns)
  checkRegistered: true,      // skip numbers that are not on WhatsApp instead of failing
  simulateTyping: true,       // show "typing..." for a moment before each message
  quietHoursEnabled: false,   // do not send between quietStart and quietEnd
  quietStart: '21:00',
  quietEnd: '08:00',          // also the earliest time a daily-limit wait resumes, even when quiet hours are off
  maxRetries: 1,              // retry a failed send this many times
  maxConsecutiveFailures: 3,  // pause the campaign after this many failures in a row
  maxConsecutiveSkips: 5,     // pause after this many "not on WhatsApp" answers in a row
  keepAwake: true,            // keep the PC from sleeping while a campaign is running or scheduled (app-level)
});

// Timers longer than ~24.8 days overflow in Node and fire at once, and a PC that
// sleeps delays them: wait in chunks and re-check the clock after each one.
const MAX_TIMER_MS = 6 * 3600 * 1000;
const MAX_SCHEDULE_DAYS = 30;

const LIMITS = {
  minDelaySec: [3, 3600],
  maxDelaySec: [3, 7200],
  batchSize: [1, 1000],
  batchPauseSec: [0, 86400],
  dailyLimit: [1, 5000],
  maxRetries: [0, 5],
  maxConsecutiveFailures: [1, 50],
  maxConsecutiveSkips: [1, 100],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  if (!TIME_RE.test(out.quietStart)) out.quietStart = DEFAULT_SETTINGS.quietStart;
  if (!TIME_RE.test(out.quietEnd)) out.quietEnd = DEFAULT_SETTINGS.quietEnd;
  return out;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const jitter = (ms, ratio) => ms * (1 + randomBetween(-ratio, ratio));

/** How long "typing..." is shown for a message of this length (ms). */
function typingDuration(text) {
  const base = 1200 + String(text || '').length * 35;
  return Math.round(Math.min(8000, jitter(base, 0.25)));
}

function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
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
  const next = new Date(nowTs);
  next.setHours(24, 0, 5, 0); // a few seconds past midnight
  return next.getTime() - nowTs;
}

/**
 * When the daily limit is reached we wait for the next day, but never resume in
 * the middle of the night: sending restarts at quietEnd (08:00 by default) at
 * the earliest, whether or not quiet hours are enabled.
 */
function dailyLimitWaitMs(settings, nowTs) {
  const midnight = nowTs + msUntilMidnight(nowTs);
  const resume = new Date(midnight);
  const [h, m] = String(settings.quietEnd || DEFAULT_SETTINGS.quietEnd).split(':').map(Number);
  resume.setHours(h || 0, m || 0, 0, 0);
  return Math.max(midnight, resume.getTime()) - nowTs;
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
const INTERRUPTED_MESSAGE = 'Interrupted while sending. It may already have been delivered: check the chat before retrying.';

/**
 * A campaign sends one rendered message per item, pacing itself according to
 * its settings. It emits:
 *   'state'  -> snapshot without items (state, counts, waiting, ...)
 *   'item'   -> { index, item } whenever one item changes
 *   'log'    -> { ts, level, message }
 *   'change' -> whenever something worth persisting changed
 *
 * `client` must provide isReady(), resolveChatId(digits) -> chatId|null and
 * sendText(chatId, text, { simulateTyping, typingMs, shouldAbort }) -> { id }.
 * sendText may throw an error named 'AbortError' when shouldAbort() asked it to
 * stop before the message went out, or one with code 'UNCONFIRMED' when the
 * message may or may not have gone out.
 * `counter` (optional) must provide sentToday(), increment() and lastSentAt().
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
    this.sentSinceBatchPause = Number(o.sentSinceBatchPause) || 0;
    this.batchPauseUntil = Number(o.batchPauseUntil) || null;
    this.scheduledAt = Number(o.scheduledAt) || null;
    this._scheduleLogged = false;
    this.consecutiveFailures = 0;
    this.consecutiveSkips = 0;
    this._waker = null;
    this._loopPromise = null;
    this._inFlight = null;
    this._dailyLimitLogged = false;
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
    if (wasPaused) {
      // A resume says "the cause has been dealt with": the in-a-row counters restart.
      this.consecutiveFailures = 0;
      this.consecutiveSkips = 0;
    }
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

  /** Resolves once no send is in flight (or after timeoutMs). Call before tearing WhatsApp down. */
  settle(timeoutMs) {
    if (!this._inFlight) return Promise.resolve();
    return Promise.race([this._inFlight.catch(() => {}), sleep(timeoutMs || 15000)]);
  }

  /** Put failed items (and optionally "not on WhatsApp" ones) back in the queue. Does not resume. */
  retryFailed(options) {
    const includeSkipped = Boolean(options && options.includeNotOnWhatsApp);
    let n = 0;
    this.items.forEach((item, index) => {
      if (item.status === 'failed' || (includeSkipped && item.status === 'not_on_whatsapp')) {
        item.status = 'pending';
        item.attempts = 0;
        item.error = null;
        if (includeSkipped) item.chatId = null;
        n++;
        this.emit('item', { index, item });
      }
    });
    if (n) {
      this.consecutiveFailures = 0;
      this.consecutiveSkips = 0;
      if (TERMINAL.has(this.state)) { this.state = 'paused'; this.pauseReason = 'Ready to retry'; this.finishedAt = null; }
      this._log('info', `${n} message(s) queued again`);
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

    // Scheduled campaign: nothing goes out before the chosen time.
    if (this.scheduledAt) {
      const left = this.scheduledAt - this.now();
      if (left > 0) { await this._wait(left, 'scheduled start'); return; }
      if (!this._scheduleLogged) {
        this._scheduleLogged = true;
        this._log('info', 'Scheduled time reached, sending starts');
      }
    }

    if (!this.client || !this.client.isReady()) {
      this.pause('WhatsApp is not connected', { auto: true });
      return;
    }

    const quietMs = quietHoursRemainingMs(this.settings, this.now());
    if (quietMs > 0) { await this._wait(quietMs, 'quiet hours'); return; }

    if (this.counter && this.counter.sentToday() >= this.settings.dailyLimit) {
      if (!this._dailyLimitLogged) {
        this._dailyLimitLogged = true;
        this._log('warn', `Daily limit of ${this.settings.dailyLimit} reached, waiting for tomorrow morning`);
      }
      await this._wait(dailyLimitWaitMs(this.settings, this.now()), 'daily limit reached');
      return;
    }
    this._dailyLimitLogged = false;

    // Batch pause as a deadline, so pause/resume or a restart cannot cut it short.
    if (this.settings.batchSize > 0 && this.sentSinceBatchPause >= this.settings.batchSize) {
      if (this.settings.batchPauseSec > 0) {
        if (!this.batchPauseUntil) {
          this.batchPauseUntil = this.now() + jitter(this.settings.batchPauseSec * 1000, 0.2);
          this.emit('change');
        }
        const left = this.batchPauseUntil - this.now();
        if (left > 0) { await this._wait(left, 'batch pause'); return; }
      }
      this.sentSinceBatchPause = 0;
      this.batchPauseUntil = null;
      this.emit('change');
    }

    // Never send two messages closer together than minDelay: not across
    // pause/resume, not across campaigns (the counter remembers the last send).
    const sharedLast = this.counter && typeof this.counter.lastSentAt === 'function' ? (this.counter.lastSentAt() || 0) : 0;
    const last = Math.max(this.lastSentAt || 0, sharedLast);
    if (last) {
      const since = this.now() - last;
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
    this.emit('change');

    const who = `${item.firstName} ${item.lastName}`.trim() || item.phoneDisplay;
    const giveBack = () => {
      item.status = 'pending';
      item.attempts = Math.max(0, item.attempts - 1);
      item.error = null;
    };

    try {
      const { text } = render(this.template, item);
      let chatId = item.chatId;
      if (!chatId) {
        if (this.settings.checkRegistered) {
          chatId = await this.client.resolveChatId(item.phone);
          if (!chatId) {
            item.status = 'not_on_whatsapp';
            item.error = 'Number is not registered on WhatsApp';
            this.consecutiveSkips += 1;
            this._log('warn', `Skipped ${who} (${item.phoneDisplay}): not on WhatsApp`);
            if (this.consecutiveSkips >= this.settings.maxConsecutiveSkips) {
              this.pause(`${this.consecutiveSkips} numbers in a row reported as not on WhatsApp. If they are landlines this is normal; otherwise check the WhatsApp connection. Resume to continue.`);
            }
            this.emit('item', { index, item });
            this._emitState();
            return;
          }
        } else {
          chatId = `${item.phone}@c.us`;
        }
        item.chatId = chatId;
      }

      // The user may have paused or stopped while the number was being checked.
      if (this.state !== 'running') {
        giveBack();
        this.emit('item', { index, item });
        this._emitState();
        return;
      }

      this._inFlight = this.client.sendText(chatId, text, {
        simulateTyping: this.settings.simulateTyping,
        typingMs: typingDuration(text),
        shouldAbort: () => this.state !== 'running',
      });
      let result;
      try { result = await this._inFlight; } finally { this._inFlight = null; }
      if (!result || !result.id) {
        const err = new Error('WhatsApp returned no message id, so the send is not confirmed');
        err.code = 'UNCONFIRMED';
        throw err;
      }

      item.status = 'sent';
      item.sentAt = this.now();
      item.messageId = result.id;
      this.lastSentAt = item.sentAt;
      this.sentSinceBatchPause += 1;
      this.consecutiveFailures = 0;
      this.consecutiveSkips = 0;
      if (this.counter) this.counter.increment();
      this._log('success', `Sent to ${who} (${item.phoneDisplay})`);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        giveBack();
        this._log('info', `Message to ${who} was cancelled before it went out`);
      } else {
        const message = err && err.message ? err.message : String(err);
        this.consecutiveFailures += 1;
        if (err && err.code === 'UNCONFIRMED') {
          // The message may still have gone out: do not retry automatically,
          // and pace/count as if it had been sent.
          item.status = 'failed';
          item.error = `${message}. Check the chat before retrying.`;
          this.lastSentAt = this.now();
          this.sentSinceBatchPause += 1;
          if (this.counter) this.counter.increment();
          this._log('error', `No confirmation for ${who} (${item.phoneDisplay}): ${message}`);
        } else if (item.attempts <= this.settings.maxRetries) {
          item.status = 'pending';
          item.error = message;
          this._log('warn', `Failed for ${who}: ${message}. Will retry.`);
        } else {
          item.status = 'failed';
          item.error = message;
          this._log('error', `Failed for ${who}: ${message}`);
        }
        if (this.consecutiveFailures >= this.settings.maxConsecutiveFailures) {
          this.pause(`${this.consecutiveFailures} failures in a row. Check the WhatsApp connection before resuming.`);
        }
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
    const duration = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
    return new Promise(resolve => {
      // `until` is the real end shown to the user; the timer itself is capped and
      // the loop simply re-checks the clock when it fires early.
      const until = this.now() + duration;
      this.waiting = { label, until, ms: duration };
      let timer = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (this._waker === finish) this._waker = null;
        this.waiting = null;
        resolve();
      };
      // Install the waker before anyone can react to the state event.
      this._waker = finish;
      timer = setTimeout(finish, Math.min(duration, MAX_TIMER_MS));
      this._emitState();
    });
  }

  /** Cancel the schedule and start sending right away (still respecting all pacing rules). */
  startNow() {
    if (!this.scheduledAt || this.scheduledAt <= this.now()) return false;
    this.scheduledAt = null;
    this._log('info', 'Schedule cancelled: sending starts now');
    this._emitState();
    this._wake();
    return true;
  }

  /** True while a scheduled campaign has not reached its start time yet. */
  isWaitingForSchedule() {
    return Boolean(this.scheduledAt && this.scheduledAt > this.now() && !TERMINAL.has(this.state));
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
      sentSinceBatchPause: this.sentSinceBatchPause,
      batchPauseUntil: this.batchPauseUntil,
      scheduledAt: this.scheduledAt,
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
    snap.wasRunning = snap.state === 'running' || (snap.state === 'paused' && this.autoPaused);
    if (snap.state === 'running') { snap.state = 'paused'; snap.pauseReason = 'Interrupted'; }
    snap.items = this.items;
    snap.logs = this.logs.slice(-500);
    return snap;
  }

  static fromJSON(json, deps) {
    const d = deps || {};
    const items = (json.items || []).map(i => {
      if (i.status !== 'sending') return { ...i };
      // A send that was in flight when the app stopped may or may not have gone
      // out. Never re-send it silently: surface it and let the user decide.
      return { ...i, status: 'failed', error: INTERRUPTED_MESSAGE };
    });
    const c = new Campaign({
      id: json.id,
      name: json.name,
      template: json.template,
      settings: sanitizeSettings(json.settings),
      items,
      logs: json.logs,
      createdAt: json.createdAt,
      startedAt: json.startedAt,
      finishedAt: json.finishedAt,
      lastSentAt: json.lastSentAt,
      sentSinceBatchPause: json.sentSinceBatchPause,
      batchPauseUntil: json.batchPauseUntil,
      scheduledAt: json.scheduledAt,
      client: d.client,
      counter: d.counter,
      now: d.now,
    });
    if (json.state === 'done' || json.state === 'stopped') {
      c.state = json.state;
    } else if (items.some(i => i.status === 'pending')) {
      c.state = 'paused';
      c.pauseReason = json.pauseReason || 'Restored after restart';
      const notStarted = items.every(i => i.status === 'pending');
      if (c.scheduledAt && json.wasRunning && notStarted) {
        if (c.scheduledAt > c.now()) {
          // Still in the future: keep the appointment. It resumes by itself once WhatsApp is connected.
          c.autoPaused = true;
          c.pauseReason = 'Scheduled: waiting for WhatsApp to connect';
        } else {
          // The time passed while the app was closed: never fire late without asking.
          c.pauseReason = `The scheduled time (${new Date(c.scheduledAt).toLocaleString()}) passed while the app was closed. Press Resume to send now, or Stop.`;
        }
      }
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
  MAX_TIMER_MS,
  MAX_SCHEDULE_DAYS,
  INTERRUPTED_MESSAGE,
  sanitizeSettings,
  estimateDurationMs,
  quietHoursRemainingMs,
  msUntilMidnight,
  dailyLimitWaitMs,
  typingDuration,
};
