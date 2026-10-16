'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CLIENT_ID = 'broadcast';

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
    this.headless = o.headless !== false;
    this.client = null;
    this.status = 'disconnected'; // disconnected | initializing | qr | authenticating | ready | auth_failure
    this.qr = null;
    this.info = null;
    this.message = null;
    this.lastError = null;
    this._lib = null;
  }

  _library() {
    if (!this._lib) this._lib = require('whatsapp-web.js');
    return this._lib;
  }

  sessionDir() {
    return path.join(this.dataPath, `session-${CLIENT_ID}`);
  }

  hasSavedSession() {
    try { return fs.existsSync(this.sessionDir()); } catch { return false; }
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
    const { Client, LocalAuth } = this._library();
    this._set('initializing', { qr: null, info: null, lastError: null, message: 'Starting the browser…' });

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: this.dataPath }),
      puppeteer: {
        headless: this.headless,
        executablePath: this.executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });
    this.client = client;

    client.on('qr', qr => {
      this._set('qr', { qr, message: 'Scan this code with WhatsApp on your phone' });
    });
    client.on('loading_screen', (percent, msg) => {
      this._set('authenticating', { qr: null, message: `Loading WhatsApp… ${percent || 0}%${msg ? ` (${msg})` : ''}` });
    });
    client.on('authenticated', () => {
      this._set('authenticating', { qr: null, message: 'Authenticated, loading your chats…' });
    });
    client.on('auth_failure', msg => {
      this._log('error', `Authentication failed: ${msg}`);
      this._set('auth_failure', { qr: null, lastError: String(msg), message: 'Authentication failed. Unlink and scan again.' });
      this._teardown();
    });
    client.on('ready', () => {
      const info = client.info || {};
      const wid = info.wid || {};
      this.info = {
        number: wid.user || null,
        name: info.pushname || null,
        platform: info.platform || null,
        serialized: widToString(wid),
      };
      this._log('info', `Connected as +${this.info.number || '?'}${this.info.name ? ` (${this.info.name})` : ''}`);
      this._set('ready', { qr: null, message: null });
    });
    client.on('change_state', state => {
      this._log('info', `WhatsApp state: ${state}`);
    });
    client.on('disconnected', reason => {
      this._log('warn', `Disconnected: ${reason}`);
      const unlinked = String(reason).toUpperCase() === 'LOGOUT';
      this._set('disconnected', {
        qr: null,
        info: null,
        message: unlinked ? 'This device was unlinked from the phone. Connect again to scan a new code.' : `Disconnected (${reason}). Click Connect to reconnect.`,
      });
      // whatsapp-web.js destroys itself on logout; give it a moment before cleaning up.
      setTimeout(() => this._teardown(), 1500);
    });

    try {
      await client.initialize();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this._log('error', `Could not start WhatsApp: ${message}`);
      this._set('disconnected', { lastError: message, message: `Could not start: ${message}` });
      await this._teardown();
    }
    return this.snapshot();
  }

  async _teardown() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try { await client.destroy(); } catch { /* already gone */ }
    if (this.status !== 'disconnected' && this.status !== 'auth_failure') {
      this._set('disconnected', { qr: null, info: null });
    }
  }

  /** Disconnect but keep the saved session (next connect needs no QR). */
  async disconnect() {
    await this._teardown();
    this._set('disconnected', { qr: null, info: null, message: 'Disconnected. The session is kept for next time.' });
  }

  /** Unlink this device from the phone and delete the saved session. */
  async logout() {
    const client = this.client;
    this.client = null;
    if (client) {
      try { await client.logout(); } catch (err) { this._log('warn', `Logout: ${err.message}`); }
      try { await client.destroy(); } catch { /* ignore */ }
    }
    await sleep(500);
    try {
      await fs.promises.rm(this.sessionDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      this._log('warn', `Could not delete the session folder: ${err.message}`);
    }
    this._set('disconnected', { qr: null, info: null, message: 'Unlinked. Connect to scan a new QR code.' });
  }

  async destroy() {
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

  async sendText(chatId, text, options) {
    const client = this._requireReady();
    const o = options || {};
    if (o.simulateTyping) {
      try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        await sleep(o.typingMs || 2000);
        await chat.clearState();
      } catch {
        // Typing indicator is cosmetic: never fail a send because of it.
      }
    }
    const msg = await client.sendMessage(chatId, text);
    return { id: msg && msg.id ? widToString(msg.id) : null };
  }

  /** Send a message to the linked number itself (for testing a template). */
  async sendToSelf(text) {
    const client = this._requireReady();
    const me = this.info && this.info.serialized;
    if (!me) throw new Error('Own number unknown');
    const msg = await client.sendMessage(me, text);
    return { id: msg && msg.id ? widToString(msg.id) : null };
  }
}

// WhatsApp Web renamed the serialized id field from `_serialized` to `$1` in
// July 2026; accept both so an older library build still resolves ids.
function widToString(wid) {
  if (!wid) return null;
  if (typeof wid === 'string') return wid;
  return wid._serialized || wid.$1 || (wid.user && wid.server ? `${wid.user}@${wid.server}` : null);
}

module.exports = WhatsApp;
