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

/** Counts messages sent per local calendar day, across campaigns and restarts. */
class DailyCounter {
  constructor(file, now = Date.now) {
    this.store = new JsonFile(file);
    this.now = now;
    this.counts = this.store.read({});
    if (typeof this.counts !== 'object' || this.counts === null) this.counts = {};
  }

  todayKey() {
    return localDateKey(this.now());
  }

  sentToday() {
    return Number(this.counts[this.todayKey()]) || 0;
  }

  increment(n = 1) {
    const key = this.todayKey();
    this.counts[key] = (Number(this.counts[key]) || 0) + n;
    // Keep only the last 60 days.
    const keys = Object.keys(this.counts).sort();
    while (keys.length > 60) delete this.counts[keys.shift()];
    try { this.store.write(this.counts); } catch { /* best effort */ }
    return this.counts[key];
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

  /** Most recent campaign that still has messages to send. */
  latestUnfinished() {
    return this.list().find(c => c.state !== 'done' && c.state !== 'stopped'
      && Array.isArray(c.items) && c.items.some(i => i.status === 'pending' || i.status === 'sending')) || null;
  }

  remove(id) {
    try { fs.unlinkSync(this.fileFor(id)); } catch { /* ignore */ }
  }
}

module.exports = { JsonFile, DailyCounter, CampaignStore, localDateKey };
