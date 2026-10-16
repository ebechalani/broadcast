/* global io */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const S = {
    wa: { status: 'disconnected' },
    settings: {},
    defaults: {},
    sentToday: 0,
    parse: null,          // last parse result from the server
    source: null,         // { file } or { text } so we can re-parse with a new mapping
    mappingTouched: false,
    campaign: null,
    filter: 'all',
    previewTimer: null,
    settingsTimer: null,
  };

  const STATUS_LABEL = {
    ok: 'Ready', invalid: 'Invalid', duplicate: 'Duplicate',
    pending: 'Pending', sending: 'Sending…', sent: 'Sent', failed: 'Failed', not_on_whatsapp: 'Not on WhatsApp',
  };

  // ---------- helpers ----------
  let toastTimer = null;
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', Boolean(isError));
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
  }

  async function api(method, url, body, isForm) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    return data;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
    return `${Math.round(h / 24)} days`;
  }
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function okContacts() {
    return S.parse ? S.parse.contacts.filter(c => c.status === 'ok') : [];
  }

  // ---------- WhatsApp connection ----------
  function renderWa() {
    const wa = S.wa || {};
    const badge = $('wa-badge');
    const map = {
      disconnected: ['Not connected', 'badge-gray'],
      initializing: ['Starting…', 'badge-blue'],
      qr: ['Waiting for QR scan', 'badge-amber'],
      authenticating: ['Connecting…', 'badge-blue'],
      ready: [`Connected: +${wa.info && wa.info.number ? wa.info.number : '?'}`, 'badge-green'],
      auth_failure: ['Authentication failed', 'badge-red'],
    };
    const [label, cls] = map[wa.status] || map.disconnected;
    badge.textContent = label;
    badge.className = `badge ${cls}`;

    const busy = wa.status === 'initializing' || wa.status === 'qr' || wa.status === 'authenticating';
    $('btn-connect').hidden = wa.status === 'ready' || busy;
    $('btn-disconnect').hidden = !(wa.status === 'ready' || busy);
    // Unlink only makes sense once a device is linked (or a stale session is left over).
    $('btn-logout').hidden = !(wa.status === 'ready' || wa.status === 'auth_failure' || (wa.status === 'disconnected' && wa.hasSavedSession));

    const text = $('wa-status-text');
    if (wa.status === 'ready') {
      text.innerHTML = 'Connected. Messages will be sent from this number.';
    } else if (wa.status === 'qr') {
      text.textContent = 'Scan the code below with the phone that holds the number you want to send from.';
    } else if (wa.message) {
      text.textContent = wa.message;
    } else {
      text.innerHTML = 'Click <b>Connect</b>, then scan the QR code with the phone that holds the number you want to send from.';
    }

    const qrBox = $('qr-box');
    if (wa.status === 'qr' && wa.qrDataUrl) {
      $('qr-img').src = wa.qrDataUrl;
      qrBox.hidden = false;
    } else {
      qrBox.hidden = true;
    }
    const info = $('wa-info');
    if (wa.status === 'ready' && wa.info) {
      info.hidden = false;
      info.innerHTML = `<span class="num">+${esc(wa.info.number)}</span><span class="muted">${esc(wa.info.name || '')}${wa.info.platform ? ` · ${esc(wa.info.platform)}` : ''}</span>`;
    } else {
      info.hidden = true;
    }
    renderCampaignButtons();
  }

  $('btn-connect').addEventListener('click', async () => {
    try { await api('POST', '/api/wa/connect'); } catch (e) { toast(e.message, true); }
  });
  $('btn-disconnect').addEventListener('click', async () => {
    try { await api('POST', '/api/wa/disconnect'); toast('Disconnected'); } catch (e) { toast(e.message, true); }
  });
  $('btn-logout').addEventListener('click', async () => {
    if (!confirm('Unlink this computer from your WhatsApp account and delete the saved session?')) return;
    try { await api('POST', '/api/wa/logout'); toast('Unlinked'); } catch (e) { toast(e.message, true); }
  });

  // ---------- Contacts ----------
  const fileInput = $('file-input');
  const dropzone = $('dropzone');
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadSource({ file: fileInput.files[0] });
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
  dropzone.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadSource({ file: f });
  });
  $('btn-parse-text').addEventListener('click', () => {
    const text = $('paste-input').value;
    if (!text.trim()) { toast('Paste some rows first', true); return; }
    loadSource({ text });
  });
  $('default-country').addEventListener('change', () => {
    saveSettings({ defaultCountry: $('default-country').value });
    if (!S.source) return;
    // Keep a mapping the user corrected by hand.
    parseSource(S.mappingTouched && S.parse ? { mapping: S.parse.mapping, hasHeader: S.parse.hasHeader } : undefined);
  });

  function loadSource(source) {
    S.source = source;
    S.mappingTouched = false;
    parseSource();
  }

  async function parseSource(override) {
    if (!S.source) return;
    const fd = new FormData();
    if (S.source.file) fd.append('file', S.source.file, S.source.file.name);
    else fd.append('text', S.source.text);
    fd.append('defaultCountry', $('default-country').value);
    if (override) {
      if (override.mapping) fd.append('mapping', JSON.stringify(override.mapping));
      if (typeof override.hasHeader === 'boolean') fd.append('hasHeader', String(override.hasHeader));
    }
    try {
      const result = await api('POST', '/api/contacts/parse', fd, true);
      S.parse = result;
      renderContacts();
      renderMapping();
      renderPlaceholderChips();
      renderPreviewSelect();
      schedulePreview();
      updateEstimate();
      const st = result.stats;
      toast(`${st.ok} contact(s) ready${st.invalid ? `, ${st.invalid} invalid` : ''}${st.duplicate ? `, ${st.duplicate} duplicate(s)` : ''}`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderMapping() {
    const box = $('mapping-box');
    if (!S.parse || !S.parse.headers.length) { box.hidden = true; return; }
    box.hidden = false;
    const headers = S.parse.headers;
    for (const role of ['firstName', 'lastName', 'fullName', 'phone']) {
      const sel = $(`map-${role}`);
      sel.innerHTML = `<option value="">(none)</option>` + headers.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
      sel.value = S.parse.mapping[role] || '';
    }
    $('map-hasHeader').checked = Boolean(S.parse.hasHeader);
  }
  $('btn-apply-mapping').addEventListener('click', () => {
    const hasHeader = $('map-hasHeader').checked;
    // When the header flag changes the column names change too, so let the server re-detect.
    const headerChanged = Boolean(S.parse) && hasHeader !== Boolean(S.parse.hasHeader);
    const override = { hasHeader };
    if (!headerChanged) {
      override.mapping = {};
      for (const role of ['firstName', 'lastName', 'fullName', 'phone']) override.mapping[role] = $(`map-${role}`).value || null;
    }
    S.mappingTouched = !headerChanged;
    parseSource(override);
  });

  function renderContacts() {
    const wrap = $('contacts-table-wrap');
    const summary = $('contacts-summary');
    if (!S.parse) { wrap.hidden = true; summary.hidden = true; return; }
    const { contacts, stats } = S.parse;
    summary.hidden = false;
    summary.innerHTML = [
      `<span class="badge badge-green">${stats.ok} ready</span>`,
      stats.invalid ? `<span class="badge badge-red">${stats.invalid} invalid</span>` : '',
      stats.duplicate ? `<span class="badge badge-amber">${stats.duplicate} duplicate</span>` : '',
      `<span class="muted small">${stats.total} row(s) read${S.source && S.source.file ? ` from ${esc(S.source.file.name)}` : ''}${S.parse.headerRow > 1 ? ` · header found on row ${S.parse.headerRow}` : ''}${S.parse.extraHeaders && S.parse.extraHeaders.length ? ` · extra columns: ${S.parse.extraHeaders.map(esc).join(', ')}` : ''}${S.parse.mapping && S.parse.mapping.phoneFallbacks && S.parse.mapping.phoneFallbacks.length ? ` · also using numbers from: ${S.parse.mapping.phoneFallbacks.map(esc).join(', ')}` : ''}</span>`,
    ].join(' ');
    wrap.hidden = false;
    const MAX = 400;
    const tbody = wrap.querySelector('tbody');
    tbody.innerHTML = contacts.slice(0, MAX).map(c => `
      <tr class="st-${c.status}">
        <td>${c.row}</td>
        <td>${esc(c.firstName)}</td>
        <td>${esc(c.lastName)}</td>
        <td>${esc(c.phoneDisplay || c.rawPhone)}${c.phoneSource ? ` <span class="muted small">(${esc(c.phoneSource)})</span>` : ''}</td>
        <td class="wrapcell">${STATUS_LABEL[c.status] || c.status}${c.reason ? ` <span class="muted small">— ${esc(c.reason)}</span>` : ''}</td>
      </tr>`).join('');
    $('contacts-more').textContent = contacts.length > MAX ? `Showing the first ${MAX} of ${contacts.length} rows.` : '';
  }

  // ---------- Message ----------
  const templateEl = $('template');
  try { templateEl.value = localStorage.getItem('wb.template') || ''; } catch { /* ignore */ }

  function renderPlaceholderChips() {
    const extra = S.parse && S.parse.extraHeaders ? S.parse.extraHeaders : [];
    const keys = ['firstName', 'lastName', 'fullName', ...extra];
    $('placeholder-chips').innerHTML = keys.map(k => `<button type="button" class="chip" data-ph="${esc(k)}">{{${esc(k)}}}</button>`).join('');
  }
  $('placeholder-chips').addEventListener('click', e => {
    const btn = e.target.closest('[data-ph]');
    if (!btn) return;
    const ins = `{{${btn.dataset.ph}}}`;
    const start = templateEl.selectionStart || 0, end = templateEl.selectionEnd || 0;
    templateEl.setRangeText(ins, start, end, 'end');
    templateEl.focus();
    templateEl.dispatchEvent(new Event('input'));
  });

  function renderPreviewSelect() {
    const sel = $('preview-contact');
    const list = okContacts().slice(0, 100);
    const prev = sel.value;
    sel.innerHTML = list.length
      ? list.map((c, i) => `<option value="${c.id}">${esc(`${c.firstName} ${c.lastName}`.trim() || c.phoneDisplay)}</option>`).join('')
      : '<option value="">(sample contact)</option>';
    if (prev && list.some(c => c.id === prev)) sel.value = prev;
  }
  $('preview-contact').addEventListener('change', schedulePreview);

  templateEl.addEventListener('input', () => {
    $('template-length').textContent = templateEl.value.length;
    try { localStorage.setItem('wb.template', templateEl.value); } catch { /* ignore */ }
    schedulePreview();
  });

  function schedulePreview() {
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(updatePreview, 200);
  }
  async function updatePreview() {
    const template = templateEl.value;
    $('template-length').textContent = template.length;
    const out = $('preview-text'), warn = $('preview-warn');
    if (!template.trim()) { out.textContent = 'Your message will appear here.'; out.classList.add('muted'); warn.hidden = true; return; }
    const id = $('preview-contact').value;
    const contact = okContacts().find(c => c.id === id) || { firstName: 'Jean', lastName: 'Dupont', phoneDisplay: '+961 70 123 456', extra: {} };
    try {
      const r = await api('POST', '/api/preview', { template, contact, extraColumns: S.parse ? S.parse.extraHeaders : [] });
      out.textContent = r.text;
      out.classList.remove('muted');
      const problems = [];
      if (r.unknown.length) problems.push(`Unknown placeholder(s): ${r.unknown.map(u => `{{${u}}}`).join(', ')} — they will be left empty.`);
      else if (r.missing.length) problems.push(`Empty for this contact: ${r.missing.map(u => `{{${u}}}`).join(', ')}.`);
      warn.hidden = !problems.length;
      warn.textContent = problems.join(' ');
    } catch (e) {
      out.textContent = e.message;
    }
  }

  $('btn-test').addEventListener('click', async () => {
    if (!S.wa || S.wa.status !== 'ready') { toast('Connect WhatsApp first', true); return; }
    const template = templateEl.value;
    if (!template.trim()) { toast('Write a message first', true); return; }
    const id = $('preview-contact').value;
    const contact = okContacts().find(c => c.id === id) || null;
    const btn = $('btn-test');
    btn.disabled = true;
    try {
      await api('POST', '/api/campaign/test', { template, contact });
      toast('Test message sent to your own number');
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  });

  // ---------- Settings ----------
  const SETTING_IDS = ['minDelaySec', 'maxDelaySec', 'batchSize', 'dailyLimit', 'maxRetries', 'maxConsecutiveFailures', 'maxConsecutiveSkips', 'checkRegistered', 'simulateTyping', 'quietHoursEnabled', 'quietStart', 'quietEnd'];

  function settingsToForm() {
    const s = S.settings;
    for (const key of SETTING_IDS) {
      const el = $(`s-${key}`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(s[key]);
      else el.value = s[key] === undefined ? '' : s[key];
    }
    $('s-batchPauseMin').value = s.batchPauseSec === undefined ? '' : Math.round((s.batchPauseSec / 60) * 10) / 10;
    const countrySel = $('default-country');
    const cc = String(s.defaultCountry || 'LB').toUpperCase();
    if (![...countrySel.options].some(o => o.value === cc)) countrySel.add(new Option(`${cc} (configured)`, cc));
    countrySel.value = cc;
    renderDailyBadge();
    validateSettings();
    updateEstimate();
  }

  function formToSettings() {
    const out = {};
    const fallback = key => (S.settings[key] !== undefined ? S.settings[key] : S.defaults[key]);
    for (const key of SETTING_IDS) {
      const el = $(`s-${key}`);
      if (!el) continue;
      if (el.type === 'checkbox') out[key] = el.checked;
      else if (el.value === '' && typeof S.defaults[key] === 'number') out[key] = fallback(key); // blank = keep current, like the server
      else out[key] = el.value;
    }
    const pauseMin = $('s-batchPauseMin').value;
    out.batchPauseSec = pauseMin === '' ? (fallback('batchPauseSec') || 0) : Math.round(Number(pauseMin) * 60);
    out.defaultCountry = $('default-country').value;
    return out;
  }

  function editingSettings() {
    const a = document.activeElement;
    return Boolean(a && /^(s-|default-country$)/.test(a.id || ''));
  }
  // Reflect the server's (clamped) values unless the user is typing in the form right now.
  function syncSettingsForm() {
    if (editingSettings()) renderDailyBadge(); else settingsToForm();
  }

  function validateSettings() {
    const s = formToSettings();
    const warnings = [];
    const min = Number(s.minDelaySec), max = Number(s.maxDelaySec);
    if (min < 15) warnings.push('A minimum delay under 15 seconds looks automated. 25–60 s is the usual safe range.');
    if (max < min) warnings.push('The maximum delay must be at least the minimum delay.');
    if (Number(s.dailyLimit) > 200) warnings.push('More than 200 messages a day from a personal number is risky. Spread large lists over several days.');
    if (Number(s.batchSize) > 30) warnings.push('Batches above 30 messages with no pause increase the chance of a ban.');
    if (!s.checkRegistered) warnings.push('Without the WhatsApp number check, messages to numbers that are not on WhatsApp will fail and count against you.');
    const el = $('settings-warn');
    el.hidden = !warnings.length;
    el.innerHTML = warnings.map(esc).join('<br>');
  }

  async function saveSettings(patch) {
    clearTimeout(S.settingsTimer);
    const body = { ...formToSettings(), ...(patch || {}) };
    S.settingsTimer = setTimeout(async () => {
      try {
        S.settings = await api('PUT', '/api/settings', body);
        syncSettingsForm();
      } catch (e) { toast(e.message, true); }
    }, 300);
  }

  for (const key of [...SETTING_IDS, 'batchPauseMin']) {
    const el = $(`s-${key}`);
    if (!el) continue;
    el.addEventListener('change', () => { validateSettings(); updateEstimate(); saveSettings(); });
    el.addEventListener('input', () => { validateSettings(); updateEstimate(); });
  }

  function estimateMs(n, s) {
    if (!n) return 0;
    const avg = ((Number(s.minDelaySec) + Number(s.maxDelaySec)) / 2) * 1000;
    const typing = s.simulateTyping ? 3500 : 500;
    const batch = Number(s.batchSize) > 0 ? Math.floor((n - 1) / Number(s.batchSize)) : 0;
    return (n - 1) * avg + n * typing + batch * Number(s.batchPauseSec) * 1000;
  }

  function updateEstimate() {
    const el = $('estimate');
    const n = okContacts().length;
    const s = formToSettings();
    if (!n) { el.textContent = 'Load contacts to see how long the campaign will take.'; return; }
    const left = Math.max(0, Number(s.dailyLimit) - S.sentToday);
    const today = Math.min(n, left);
    if (!today) {
      el.textContent = `${n} message(s) to send. Today's limit (${s.dailyLimit}) is already reached: sending starts tomorrow morning at ${s.quietEnd || '08:00'}.`;
      return;
    }
    let text = `${n} message(s) to send · estimated ${fmtDuration(estimateMs(today, s))}`;
    if (today < n) text += ` for the first ${today} today; the remaining ${n - today} go out from tomorrow ${s.quietEnd || '08:00'} because of the daily limit (${s.dailyLimit}/day, ${S.sentToday} already sent).`;
    el.textContent = text;
  }

  function renderDailyBadge() {
    const limit = S.settings.dailyLimit || (S.defaults && S.defaults.dailyLimit) || 150;
    $('daily-badge').textContent = `Today: ${S.sentToday} / ${limit}`;
    $('daily-badge').className = `badge ${S.sentToday >= limit ? 'badge-red' : S.sentToday > limit * 0.8 ? 'badge-amber' : 'badge-gray'}`;
  }

  // ---------- Campaign ----------
  function campaignActive() {
    return S.campaign && (S.campaign.state === 'running' || S.campaign.state === 'paused' || S.campaign.state === 'idle');
  }

  $('btn-start').addEventListener('click', async () => {
    if (!S.wa || S.wa.status !== 'ready') { toast('Connect WhatsApp first (step 1)', true); return; }
    const contacts = okContacts();
    if (!contacts.length) { toast('Load contacts first (step 2)', true); return; }
    const template = templateEl.value.trim();
    if (!template) { toast('Write the message first (step 3)', true); return; }
    const s = formToSettings();
    if (Number(s.maxDelaySec) < Number(s.minDelaySec)) { toast('Fix the delays: the maximum must be at least the minimum', true); return; }
    const est = fmtDuration(estimateMs(Math.min(contacts.length, Math.max(0, Number(s.dailyLimit) - S.sentToday)), s));
    const ok = confirm(`Send ${contacts.length} personalized message(s) from +${S.wa.info ? S.wa.info.number : '?'}?\n\nDelay ${s.minDelaySec}–${s.maxDelaySec} s between messages, batches of ${s.batchSize}, ${s.dailyLimit}/day max.\nEstimated time: ${est}.\n\nKeep this window and your phone online while sending.`);
    if (!ok) return;
    $('btn-start').disabled = true;
    try {
      const snap = await api('POST', '/api/campaign/start', { contacts, template, settings: s, name: `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${contacts.length} contacts` });
      S.campaign = snap;
      renderCampaign(true);
      toast('Campaign started');
    } catch (e) { toast(e.message, true); } finally { $('btn-start').disabled = false; }
  });
  $('btn-pause').addEventListener('click', () => api('POST', '/api/campaign/pause').catch(e => toast(e.message, true)));
  $('btn-resume').addEventListener('click', () => api('POST', '/api/campaign/resume').catch(e => toast(e.message, true)));
  $('btn-stop').addEventListener('click', () => {
    if (!confirm('Stop the campaign? Messages not yet sent will stay unsent.')) return;
    api('POST', '/api/campaign/stop').catch(e => toast(e.message, true));
  });
  $('btn-retry').addEventListener('click', async () => {
    const c = S.campaign;
    if (!c) return;
    const failed = (c.counts && c.counts.failed) || 0;
    const skipped = (c.counts && c.counts.notOnWhatsApp) || 0;
    let includeNotOnWhatsApp = false;
    if (skipped) includeNotOnWhatsApp = confirm(`Also queue the ${skipped} number(s) reported as "not on WhatsApp"?\n\nOK = yes, retry them too.  Cancel = only the ${failed} failed message(s).`);
    try {
      const r = await api('POST', '/api/campaign/retry-failed', { includeNotOnWhatsApp, resume: false });
      toast(r.requeued ? `${r.requeued} message(s) queued again. Press Resume when you are ready.` : 'Nothing to retry');
    } catch (e) { toast(e.message, true); }
  });
  $('btn-discard').addEventListener('click', async () => {
    if (S.campaign && S.campaign.state === 'paused' && S.campaign.counts.pending && !confirm(`${S.campaign.counts.pending} message(s) were not sent. Discard this campaign anyway?`)) return;
    try { await api('POST', '/api/campaign/discard'); S.campaign = null; renderCampaign(true); } catch (e) { toast(e.message, true); }
  });
  document.querySelector('.results-filter').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    S.filter = btn.dataset.filter;
    document.querySelectorAll('.results-filter .chip').forEach(c => c.classList.toggle('active', c === btn));
    renderResults();
  });

  function renderCampaignButtons() {
    const c = S.campaign;
    const state = c ? c.state : null;
    const waReady = S.wa && S.wa.status === 'ready';
    $('btn-start').hidden = Boolean(c) && state !== 'done' && state !== 'stopped';
    $('btn-pause').hidden = state !== 'running';
    $('btn-resume').hidden = state !== 'paused';
    $('btn-resume').disabled = !waReady;
    $('btn-resume').title = waReady ? '' : 'Connect WhatsApp first';
    $('btn-stop').hidden = !(state === 'running' || state === 'paused');
    $('btn-retry').hidden = !(c && c.counts && (c.counts.failed > 0 || c.counts.notOnWhatsApp > 0) && state !== 'running');
    for (const id of ['btn-start', 'btn-pause', 'btn-resume', 'btn-stop', 'btn-retry', 'btn-discard']) {
      if (S.offline) $(id).disabled = true;
      else if (id !== 'btn-resume') $(id).disabled = false;
    }
    $('btn-export').hidden = !c;
    $('btn-discard').hidden = !c || state === 'running';
    if (c && (state === 'done' || state === 'stopped')) $('btn-start').hidden = true;
  }

  function renderCampaign(full) {
    const c = S.campaign;
    const box = $('campaign-box');
    renderCampaignButtons();
    if (!c) { box.hidden = true; $('settings-details').open = true; $('settings-note').hidden = true; S.lastCampaignState = null; return; }
    box.hidden = false;
    const note = $('settings-note');
    if (c.state === 'running' || c.state === 'paused') {
      const cs = c.settings || {};
      note.hidden = false;
      note.textContent = `The current campaign keeps the values it started with (${cs.minDelaySec}–${cs.maxDelaySec} s, batches of ${cs.batchSize}, ${cs.dailyLimit}/day). Changes here apply to the next campaign.`;
    } else note.hidden = true;
    const stateCls = { running: 'badge-green', paused: 'badge-amber', done: 'badge-blue', stopped: 'badge-gray', idle: 'badge-gray' }[c.state] || 'badge-gray';
    $('campaign-state').textContent = c.state === 'running' && c.waiting ? 'running' : c.state;
    $('campaign-state').className = `badge ${stateCls}`;
    $('campaign-name').textContent = c.name || '';
    const reason = $('campaign-reason');
    if (c.state === 'paused' && c.pauseReason) {
      reason.hidden = false;
      reason.textContent = `${c.pauseReason}${c.autoPaused ? ' — it resumes by itself once WhatsApp is connected again (the app retries for a few minutes; otherwise click Connect).' : ''}`;
    } else reason.hidden = true;
    const n = c.counts || {};
    const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
    $('progress-bar').style.width = `${pct}%`;
    $('campaign-counts').innerHTML = [
      `<span><b>${n.sent || 0}</b> sent</span>`,
      `<span><b>${n.pending || 0}</b> pending</span>`,
      `<span><b>${n.failed || 0}</b> failed</span>`,
      `<span><b>${n.notOnWhatsApp || 0}</b> not on WhatsApp</span>`,
      `<span>${pct}% of ${n.total || 0}</span>`,
      c.state === 'running' && n.pending ? `<span>≈ ${fmtDuration(c.estimatedRemainingMs || 0)} left</span>` : '',
    ].join('');
    if (c.template && !templateEl.value.trim()) { templateEl.value = c.template; templateEl.dispatchEvent(new Event('input')); }
    if (c.state === 'running' && S.lastCampaignState !== 'running') $('settings-details').open = false;
    S.lastCampaignState = c.state;
    tickCountdown();
    if (full) renderResults();
  }

  function renderResults() {
    const c = S.campaign;
    const tbody = document.querySelector('#results-table tbody');
    if (!c || !c.items) { tbody.innerHTML = ''; return; }
    const items = c.items.map((it, i) => ({ it, i })).filter(({ it }) => S.filter === 'all' || it.status === S.filter);
    const MAX = 500;
    tbody.innerHTML = items.slice(0, MAX).map(({ it, i }) => rowHtml(it, i)).join('');
    $('results-more').textContent = items.length > MAX ? `Showing the first ${MAX} of ${items.length} rows.` : (items.length ? '' : 'Nothing to show for this filter.');
  }
  function rowHtml(it, i) {
    const detail = it.status === 'sent' && it.sentAt ? `at ${fmtTime(it.sentAt)}` : (it.error || (it.status === 'pending' && it.attempts ? `retry ${it.attempts}` : ''));
    return `<tr class="st-${it.status}" data-index="${i}">
      <td>${i + 1}</td>
      <td>${esc(`${it.firstName} ${it.lastName}`.trim())}</td>
      <td>${esc(it.phoneDisplay || it.phone)}</td>
      <td class="status">${STATUS_LABEL[it.status] || it.status}</td>
      <td class="wrapcell muted small">${esc(detail)}</td>
    </tr>`;
  }
  function updateRow(index, item) {
    if (!S.campaign) return;
    if (!S.campaign.items) S.campaign.items = [];
    S.campaign.items[index] = item;
    const tbody = document.querySelector('#results-table tbody');
    const existing = tbody.querySelector(`tr[data-index="${index}"]`);
    const show = S.filter === 'all' || item.status === S.filter;
    if (existing) {
      if (show) existing.outerHTML = rowHtml(item, index); else existing.remove();
    } else if (show) {
      renderResults();
    }
  }

  function tickCountdown() {
    const c = S.campaign;
    const el = $('campaign-wait');
    if (S.offline) { el.textContent = 'Connection to the app lost'; return; }
    if (!c || c.state !== 'running') { el.textContent = ''; return; }
    if (!c.waiting) { el.textContent = c.counts && c.counts.sending ? 'Sending…' : 'Working…'; return; }
    const remaining = Math.max(0, c.waiting.until - Date.now());
    const until = new Date(c.waiting.until);
    const sameDay = until.toDateString() === new Date().toDateString();
    const when = `${sameDay ? '' : `${until.toLocaleDateString([], { weekday: 'long' })} `}${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const labels = {
      'next message': `Next message in ${fmtDuration(remaining)}`,
      'batch pause': `Batch pause, resuming in ${fmtDuration(remaining)}`,
      'quiet hours': `Quiet hours, resuming ${sameDay ? 'at' : ''} ${when}`,
      'daily limit reached': `Daily limit reached, resuming ${sameDay ? 'at' : ''} ${when}`,
    };
    el.textContent = labels[c.waiting.label] || `${c.waiting.label}: ${fmtDuration(remaining)}`;
  }
  setInterval(tickCountdown, 500);

  // ---------- Log ----------
  function appendLog(entry, skipScroll) {
    const log = $('log');
    const div = document.createElement('div');
    div.className = `l-${entry.level}`;
    div.innerHTML = `<span class="ts">${fmtTime(entry.ts)}</span>${esc(entry.message)}`;
    log.appendChild(div);
    while (log.children.length > 400) log.removeChild(log.firstChild);
    if (!skipScroll) log.scrollTop = log.scrollHeight;
  }

  // ---------- Socket ----------
  const socket = io({ reconnectionDelayMax: 3000 });
  socket.on('state', state => {
    S.wa = state.wa;
    S.settings = state.settings || {};
    S.defaults = state.defaults || {};
    S.sentToday = state.sentToday || 0;
    S.campaign = state.campaign;
    settingsToForm();
    renderWa();
    $('log').innerHTML = '';
    (state.logs || []).forEach(e => appendLog(e, true));
    if (state.campaign && state.campaign.logs) state.campaign.logs.forEach(e => appendLog(e, true));
    $('log').scrollTop = $('log').scrollHeight;
    renderCampaign(true);
    if (state.campaign && state.campaign.state === 'paused' && state.campaign.counts.pending) {
      toast(`Unfinished campaign found: ${state.campaign.counts.pending} message(s) left. Resume it in step 4.`);
    }
  });
  socket.on('wa', wa => { S.wa = wa; renderWa(); });
  socket.on('settings', s => { S.settings = s; syncSettingsForm(); });
  socket.on('campaign', snap => {
    if (!snap) { S.campaign = null; renderCampaign(true); return; }
    if (typeof snap.sentToday === 'number') { S.sentToday = snap.sentToday; renderDailyBadge(); updateEstimate(); }
    const sameCampaign = S.campaign && S.campaign.id === snap.id;
    const items = snap.items || (sameCampaign ? S.campaign.items : null);
    S.campaign = { ...(sameCampaign ? S.campaign : {}), ...snap, items: items || [] };
    if (!items) api('GET', '/api/state').then(st => { S.campaign = st.campaign; renderCampaign(true); }).catch(() => {});
    renderCampaign(!sameCampaign || Boolean(snap.items));
  });
  socket.on('campaign:item', ({ index, item, sentToday }) => {
    updateRow(index, item);
    if (item.status === 'sending' && S.campaign) {
      // The wait is over and a message is going out: stop showing a stale countdown.
      S.campaign.waiting = null;
      S.campaign.counts = { ...(S.campaign.counts || {}), sending: 1 };
      tickCountdown();
    }
    if (typeof sentToday === 'number') { S.sentToday = sentToday; renderDailyBadge(); updateEstimate(); }
  });
  socket.on('log', entry => appendLog(entry));
  socket.on('disconnect', () => {
    S.offline = true;
    $('offline-banner').hidden = false;
    renderCampaignButtons();
    tickCountdown();
  });
  socket.on('connect', () => {
    // The server pushes a full 'state' right after connecting, which re-renders everything.
    S.offline = false;
    $('offline-banner').hidden = true;
  });

  window.addEventListener('beforeunload', e => {
    if (S.campaign && S.campaign.state === 'running') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  updatePreview();
})();
