'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CLIENT_ID = 'broadcast';
const SEND_TIMEOUT_MS = 60000;

class AbortError extends Error {
  constructor(message) {
    super(message || 'Send cancelled');
    this.name = 'AbortError';
  }
}

// WhatsApp Web renamed the serialized id field from `_serialized` to `$1` in
// July 2026; accept both so an older library build still resolves ids.
function widToString(wid) {
  if (!wid) return null;
  if (typeof wid === 'string') return wid;
  return wid._serialized || wid.$1 || (wid.user && wid.server ? `${wid.user}@${wid.server}` : null);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'UNCONFIRMED';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Thin wrapper around whatsapp-web.js. It owns the client lifecycle and exposes
 * the three calls the Campaign needs: isReady(), resolveChatId(), sendText().
 *
 * Emits 'status' with snapshot() whenever the connection state changes and
 * 'log' with { level, message } for noteworthy events.
 */
class WhatsApp extends EventEmitter {
  constructor(options) {
    super();
    const o = options || {};
    this.dataPath = o.dataPath;
    this.executablePath = o.executablePath || undefined;
    this.headless = o.headless === true;
    this.client = null;
    this.status = 'disconnected'; // disconnected | initializing | qr | authenticating | ready | auth_failure
    this.qr = null;
    this.info = null;
    this.message = null;
    this.lastError = null;
    this.lastDisconnectReason = null;
    this.manualDisconnect = false;
    this._lib = null;
    this._initPromise = null;
    this._initSettled = true;
    this._closing = null;
  }

  _library() {
    if (!this._lib) this._lib = require('whatsapp-web.js');
    return this._lib;
  }

  sessionDir() {
    return path.join(this.dataPath, `session-${CLIENT_ID}`);
  }

  markerFile() {
    return path.join(this.dataPath, 'linked.json');
  }

  /** True only after a device was actually linked (the browser profile alone proves nothing). */
  hasSavedSession() {
    try { return fs.existsSync(this.markerFile()) && fs.existsSync(this.sessionDir()); } catch { return false; }
  }

  isReady() {
    return this.status === 'ready' && Boolean(this.client);
  }

  snapshot() {
    return {
      status: this.status,
      qr: this.qr,
      info: this.info,
      message: this.message,
      lastError: this.lastError,
      lastDisconnectReason: this.lastDisconnectReason,
      manualDisconnect: this.manualDisconnect,
      hasSavedSession: this.hasSavedSession(),
    };
  }

  _set(status, patch) {
    this.status = status;
    if (patch) Object.assign(this, patch);
    this.emit('status', this.snapshot());
  }

  _log(level, message) {
    this.emit('log', { level, message });
  }

  async connect() {
    if (this.client) return this.snapshot();
    if (this._closing) { try { await this._closing; } catch { /* ignore */ } }
    if (this.client) return this.snapshot();

    this.manualDisconnect = false;
    const { Client, LocalAuth } = this._library();
    this._set('initializing', { qr: null, info: null, lastError: null, message: 'Starting the browser…' });

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: this.dataPath, rmMaxRetries: 10 }),
      // Always load the live WhatsApp Web; the default cache writes into the process cwd.
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: this.headless,
        executablePath: this.executablePath,
        // The app closes the browser itself on shutdown; puppeteer must not exit the process on Ctrl+C.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });
    this.client = client;
    const current = () => this.client === client;

    client.on('qr', qr => {
      if (!current()) return;
      this._set('qr', { qr, message: 'Scan this code with WhatsApp on your phone' });
    });
    client.on('loading_screen', (percent, msg) => {
      // Also fires for sync progress after 'ready': never move backwards.
      if (!current() || this.status === 'ready') return;
      this._set('authenticating', { qr: null, message: `Loading WhatsApp… ${percent || 0}%${msg ? ` (${msg})` : ''}` });
    });
    client.on('authenticated', () => {
      if (!current() || this.status === 'ready') return;
      this._set('authenticating', { qr: null, message: 'Authenticated, loading your chats…' });
    });
    client.on('auth_failure', msg => {
      if (!current()) return;
      this._log('error', `Authentication failed: ${msg}`);
      this._set('auth_failure', { qr: null, lastError: String(msg), message: 'Authentication failed. Unlink and scan again.' });
      this._teardown(client);
    });
    client.on('ready', () => {
      if (!current()) return;
      const info = client.info || {};
      const wid = info.wid || {};
      this.info = {
        number: wid.user || null,
        name: info.pushname || null,
        platform: info.platform || null,
        serialized: widToString(wid),
      };
      this._writeMarker();
      this._log('info', `Connected as +${this.info.number || '?'}${this.info.name ? ` (${this.info.name})` : ''}`);
      this._set('ready', { qr: null, message: null, lastDisconnectReason: null });
    });
    client.on('change_state', state => {
      if (current()) this._log('info', `WhatsApp state: ${state}`);
    });
    client.on('disconnected', reason => {
      if (!current()) return;
      this._onDisconnected(client, reason).catch(err => this._log('error', `Disconnect handling failed: ${err.message}`));
    });

    this._initSettled = false;
    this._initPromise = client.initialize();
    try {
      await this._initPromise;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this._log('error', `Could not start WhatsApp: ${message}`);
      this._initSettled = true;
      if (current()) {
        this._set('disconnected', { lastError: message, message: `Could not start: ${message}` });
        await this._teardown(client);
      }
    } finally {
      this._initSettled = true;
      this._initPromise = null;
    }
    return this.snapshot();
  }

  async _onDisconnected(client, reason) {
    const r = String(reason || '').toUpperCase();
    const unlinked = r === 'LOGOUT';
    this.lastDisconnectReason = r;
    this._log('warn', `Disconnected: ${reason}`);
    this._set('disconnected', {
      qr: null,
      info: null,
      message: unlinked
        ? 'This device was unlinked from the phone. Connect again to scan a new code.'
        : `Disconnected (${reason}). Reconnecting…`,
    });
    await this._teardown(client);
    if (unlinked) {
      await this._removeSession();
      this._set('disconnected');
    }
  }

  /** Close a client's browser, waiting for a launch that is still in progress. */
  async _teardown(client) {
    const target = client || this.client;
    if (!target) return;
    if (this.client === target) this.client = null;
    const closing = (async () => {
      // Puppeteer sets pupBrowser only once Chrome is up; destroying before that would orphan it.
      for (let i = 0; i < 75 && !target.pupBrowser && !this._initSettled; i++) await sleep(200);
      try { await target.destroy(); } catch { /* already gone */ }
    })();
    this._closing = closing;
    try { await closing; } finally { if (this._closing === closing) this._closing = null; }
  }

  async _removeSession() {
    await sleep(500);
    try {
      await fs.promises.rm(this.sessionDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      this._log('warn', `Could not delete the session folder: ${err.message}`);
    }
    this._clearMarker();
  }

  _writeMarker() {
    try {
      fs.mkdirSync(this.dataPath, { recursive: true });
      fs.writeFileSync(this.markerFile(), JSON.stringify({ number: this.info && this.info.number, linkedAt: Date.now() }));
    } catch { /* best effort */ }
  }

  _clearMarker() {
    try { fs.rmSync(this.markerFile(), { force: true }); } catch { /* ignore */ }
  }

  /** Disconnect but keep the saved session (next connect needs no QR). */
  async disconnect() {
    this.manualDisconnect = true;
    await this._teardown();
    this._set('disconnected', { qr: null, info: null, message: 'Disconnected. The session is kept for next time.' });
  }

  /** Unlink this device from the phone and delete the saved session. */
  async logout() {
    this.manualDisconnect = true;
    const client = this.client;
    this.client = null;
    if (client) {
      for (let i = 0; i < 75 && !client.pupBrowser && !this._initSettled; i++) await sleep(200);
      if (client.pupPage) {
        try { await client.logout(); } catch (err) { this._log('warn', `Logout: ${err.message}`); }
      }
      try { await client.destroy(); } catch { /* ignore */ }
    }
    await this._removeSession();
    this._set('disconnected', { qr: null, info: null, lastDisconnectReason: 'LOGOUT', message: 'Unlinked. Connect to scan a new QR code.' });
  }

  async destroy() {
    this.manualDisconnect = true;
    await this._teardown();
  }

  _requireReady() {
    if (!this.isReady()) throw new Error('WhatsApp is not connected');
    return this.client;
  }

  /** Chat id for a number (digits only, with country code) or null if not on WhatsApp. */
  async resolveChatId(digits) {
    const client = this._requireReady();
    const id = await client.getNumberId(String(digits));
    return id ? widToString(id) : null;
  }

  /**
   * Send a text and only report success once WhatsApp confirmed the message.
   * Throws AbortError if options.shouldAbort() asks to stop before sending,
   * and an error with code 'UNCONFIRMED' when the outcome is unknown.
   */
  async sendText(chatId, text, options) {
    const client = this._requireReady();
    const o = options || {};
    if (o.simulateTyping) {
      let chat = null;
      try {
        chat = await client.getChatById(chatId);
        if (chat) await chat.sendStateTyping();
        else this._log('warn', `No chat object for ${chatId}, typing indicator skipped`);
      } catch (err) {
        this._log('warn', `Typing indicator failed: ${err.message}`);
      }
      // The pause itself is part of the pacing, whether or not the indicator worked.
      await sleep(o.typingMs || 2000);
      try { if (chat) await chat.clearState(); } catch { /* cosmetic */ }
    }
    if (o.shouldAbort && o.shouldAbort()) throw new AbortError();
    if (!this.isReady()) throw new Error('WhatsApp is not connected');

    const msg = await withTimeout(
      client.sendMessage(chatId, text, { waitUntilMsgSent: true }),
      SEND_TIMEOUT_MS,
      `WhatsApp did not confirm the message within ${SEND_TIMEOUT_MS / 1000} s`
    );
    const id = msg && msg.id ? widToString(msg.id) : null;
    if (!id) {
      const err = new Error('WhatsApp did not return a message id');
      err.code = 'UNCONFIRMED';
      throw err;
    }
    if (typeof msg.ack === 'number' && msg.ack < 0) {
      throw new Error(`WhatsApp rejected the message (ack ${msg.ack})`);
    }
    return { id, ack: msg.ack };
  }

  /** Send a message to the linked number itself (for testing a template). */
  async sendToSelf(text) {
    const client = this._requireReady();
    const me = this.info && this.info.serialized;
    if (!me) throw new Error('Own number unknown');
    const msg = await withTimeout(client.sendMessage(me, text, { waitUntilMsgSent: true }), SEND_TIMEOUT_MS, 'WhatsApp did not confirm the test message');
    const id = msg && msg.id ? widToString(msg.id) : null;
    if (!id) throw new Error('WhatsApp did not return a message id');
    return { id };
  }
}

WhatsApp.AbortError = AbortError;
WhatsApp.widToString = widToString;
module.exports = WhatsApp;
