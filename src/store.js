'use strict';
const fs = require('fs');
const path = require('path');

/** Small JSON file with atomic writes (write to a temp file, then rename). */
class JsonFile {
  constructor(file) {
    this.file = file;
  }

  read(fallback) {
    try {
      if (!fs.existsSync(this.file)) return fallback;
      const raw = fs.readFileSync(this.file, 'utf8');
      return raw.trim() ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function localDateKey(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Counts messages sent per local calendar day, across campaigns and restarts,
 * and remembers when the last message went out so the minimum gap between two
 * messages also holds across campaigns.
 */
class DailyCounter {
  constructor(file, now = Date.now) {
    this.store = new JsonFile(file);
    this.now = now;
    const raw = this.store.read({});
    this.days = {};
    this._lastSentAt = null;
    if (raw && typeof raw === 'object') {
      if (raw.days && typeof raw.days === 'object') {
        for (const [k, v] of Object.entries(raw.days)) if (DAY_KEY.test(k)) this.days[k] = Number(v) || 0;
        this._lastSentAt = Number(raw.lastSentAt) || null;
      } else {
        // Legacy flat format: { "2026-10-16": 12 }
        for (const [k, v] of Object.entries(raw)) if (DAY_KEY.test(k)) this.days[k] = Number(v) || 0;
      }
    }
  }

  todayKey() {
    return localDateKey(this.now());
  }

  sentToday() {
    return Number(this.days[this.todayKey()]) || 0;
  }

  lastSentAt() {
    return this._lastSentAt;
  }

  increment(n = 1) {
    const key = this.todayKey();
    this.days[key] = (Number(this.days[key]) || 0) + n;
    this._lastSentAt = this.now();
    // Keep only the last 60 days.
    const keys = Object.keys(this.days).sort();
    while (keys.length > 60) delete this.days[keys.shift()];
    try { this.store.write({ days: this.days, lastSentAt: this._lastSentAt }); } catch { /* best effort */ }
    return this.days[key];
  }
}

/** Campaign snapshots on disk so an interrupted run can be resumed after a restart. */
class CampaignStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(id) {
    return path.join(this.dir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }

  save(campaign) {
    new JsonFile(this.fileFor(campaign.id)).write(campaign.toJSON());
  }

  load(id) {
    return new JsonFile(this.fileFor(id)).read(null);
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => new JsonFile(path.join(this.dir, f)).read(null))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** Most recent campaign that still has messages to send (or an interrupted send to review). */
  latestUnfinished() {
    return this.list().find(c => c.state !== 'done' && c.state !== 'stopped'
      && Array.isArray(c.items) && c.items.some(i => i.status === 'pending' || i.status === 'sending')) || null;
  }

  remove(id) {
    try { fs.unlinkSync(this.fileFor(id)); } catch { /* ignore */ }
  }
}

module.exports = { JsonFile, DailyCounter, CampaignStore, localDateKey };
