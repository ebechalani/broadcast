'use strict';
const Papa = require('papaparse');
const XLSX = require('xlsx');
const { normalizePhone, looksLikePhone, toRawString } = require('./phone');
const { normKey } = require('./template');

const FIRST_NAMES = ['firstname', 'first', 'prenom', 'prenoms', 'givenname', 'forename', 'firstnames', 'prenomeleve', 'prenomparent'];
const LAST_NAMES = ['lastname', 'last', 'surname', 'nom', 'noms', 'famille', 'nomdefamille', 'familyname', 'family', 'nomeleve', 'nomparent'];
const FULL_NAMES = ['name', 'fullname', 'nomcomplet', 'nomprenom', 'prenomnom', 'nometprenom', 'contact', 'eleve', 'student', 'parent', 'personne'];
const PHONES = ['phone', 'phonenumber', 'telephone', 'tel', 'numero', 'numerodetelephone', 'mobile', 'whatsapp', 'whatsappnumber', 'number', 'gsm', 'cell', 'cellphone', 'portable', 'numwhatsapp', 'mobilephone', 'telwhatsapp', 'numerowhatsapp'];

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls|ods|xlsb)$/i;

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function cellToString(v) {
  if (typeof v === 'number') return toRawString(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return isBlank(v) ? '' : String(v).trim();
}

/**
 * Decode a text file. Excel on Windows saves CSV as ANSI (Windows-1252) unless
 * "CSV UTF-8" is chosen, and "Unicode Text" exports are UTF-16LE with a BOM.
 */
function decodeText(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.toString('utf16le').replace(/^﻿/, '');
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return swapped.toString('utf16le').replace(/^﻿/, '');
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('windows-1252').decode(buffer); } catch { return buffer.toString('latin1'); }
}

/** Turn an uploaded file or pasted text into a matrix of strings (rows x columns). */
function toMatrix({ buffer, filename, text }) {
  if (buffer && filename && SPREADSHEET_EXT.test(filename)) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return [];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    return rows.map(r => r.map(cellToString));
  }
  let csv = text;
  if (csv === undefined || csv === null) {
    csv = buffer ? decodeText(buffer) : '';
  }
  csv = String(csv).replace(/^﻿/, '');
  if (!csv.trim()) return [];
  const result = Papa.parse(csv, {
    header: false,
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', ';', '\t', '|'],
  });
  return result.data.map(r => r.map(cellToString));
}

function dropEmptyRowsAndColumns(matrix) {
  const rows = matrix.filter(r => r.some(c => !isBlank(c)));
  if (!rows.length) return [];
  const width = Math.max(...rows.map(r => r.length));
  const keep = [];
  for (let c = 0; c < width; c++) {
    if (rows.some(r => !isBlank(r[c]))) keep.push(c);
  }
  return rows.map(r => keep.map(c => (r[c] === undefined ? '' : r[c])));
}

/** A first row with no phone-like cell is treated as a header row. */
function detectHeader(rows) {
  if (!rows.length) return false;
  const first = rows[0];
  if (first.some(looksLikePhone)) return false;
  if (rows.length === 1) return false;
  return true;
}

function positionalHeaders(width) {
  return Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
}

function phoneScore(rows, col) {
  let hits = 0, total = 0;
  for (const r of rows) {
    if (isBlank(r[col])) continue;
    total++;
    if (looksLikePhone(r[col])) hits++;
  }
  return total ? hits / total : 0;
}

function guessPhoneColumn(headers, rows) {
  let best = null, bestScore = 0;
  headers.forEach((h, col) => {
    const score = phoneScore(rows, col);
    if (score > bestScore) { bestScore = score; best = h; }
  });
  return bestScore >= 0.5 ? best : null;
}

/**
 * Work out which column holds which field.
 * Returns { firstName, lastName, fullName, phone } with header names (or null).
 */
function detectMapping(headers, rows, hasHeader) {
  const norm = headers.map(h => ({ raw: h, key: normKey(h) }));
  const exact = list => { const hit = norm.find(h => list.includes(h.key)); return hit ? hit.raw : null; };
  const fuzzy = re => { const hit = norm.find(h => re.test(h.key)); return hit ? hit.raw : null; };

  let phone = null, firstName = null, lastName = null, fullName = null;

  if (hasHeader) {
    phone = exact(PHONES) || fuzzy(/(whatsapp|tel|phone|mobile|numero|gsm|portable|cell)/);
    firstName = exact(FIRST_NAMES) || fuzzy(/(prenom|first|given)/);
    lastName = exact(LAST_NAMES) || fuzzy(/(surname|lastname|last|famil)/);
    if (!lastName) {
      const nomCol = norm.find(h => h.key === 'nom' || /^noms?(de)?(famille)?$/.test(h.key));
      if (nomCol && nomCol.raw !== firstName) lastName = nomCol.raw;
    }
    // "Nom" alone, without a first-name column, is usually the full name.
    if (lastName && !firstName && /^noms?$/.test(normKey(lastName))) {
      fullName = lastName; lastName = null;
    }
    if (!firstName && !lastName) {
      fullName = fullName || exact(FULL_NAMES) || fuzzy(/(name|nom|eleve|student|parent|contact)/);
    }
  }
  if (!phone) phone = guessPhoneColumn(headers, rows);

  if (!hasHeader || (!firstName && !lastName && !fullName)) {
    // Positional fallback: the non-phone, mostly-text columns in order.
    const textCols = headers.filter(h => h !== phone && h !== fullName && h !== firstName && h !== lastName)
      .filter(h => phoneScore(rows, headers.indexOf(h)) < 0.5)
      .filter(h => rows.some(r => !isBlank(r[headers.indexOf(h)]) && /[A-Za-zÀ-ɏ؀-ۿ]/.test(r[headers.indexOf(h)])));
    if (!firstName && !lastName && !fullName) {
      if (textCols.length >= 2) { firstName = textCols[0]; lastName = textCols[1]; }
      else if (textCols.length === 1) { fullName = textCols[0]; }
    }
  }
  // A column may only play one role.
  const roles = ['phone', 'firstName', 'lastName', 'fullName'];
  const picked = { phone, firstName, lastName, fullName };
  const used = new Set();
  for (const role of roles) {
    if (picked[role] && used.has(picked[role])) picked[role] = null;
    if (picked[role]) used.add(picked[role]);
  }
  return picked;
}

/**
 * Split "DUPONT Jean" / "Jean Dupont" into first and last name.
 * Upper-case leading tokens are treated as the surname (common in French lists).
 */
function splitFullName(full) {
  const tokens = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  const isUpper = t => t.length > 1 && t === t.toUpperCase() && t !== t.toLowerCase();
  if (isUpper(tokens[0]) && !tokens.every(isUpper)) {
    let i = 0;
    while (i < tokens.length - 1 && isUpper(tokens[i])) i++;
    return { lastName: tokens.slice(0, i).join(' '), firstName: tokens.slice(i).join(' ') };
  }
  if (!isUpper(tokens[0]) && isUpper(tokens[tokens.length - 1])) {
    let i = tokens.length - 1;
    while (i > 0 && isUpper(tokens[i])) i--;
    return { firstName: tokens.slice(0, i + 1).join(' '), lastName: tokens.slice(i + 1).join(' ') };
  }
  return { firstName: tokens[0], lastName: tokens.slice(1).join(' ') };
}

function titleCaseIfShouting(s) {
  const str = String(s || '').trim();
  if (str.length > 2 && str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }
  return str;
}

/**
 * Parse an upload into contacts.
 * @param {{buffer?: Buffer, filename?: string, text?: string}} input
 * @param {{defaultCountry?: string, mapping?: object, hasHeader?: boolean|null, prettifyNames?: boolean}} options
 */
function parseContacts(input, options = {}) {
  const defaultCountry = (options.defaultCountry || 'LB').toUpperCase();
  const matrix = dropEmptyRowsAndColumns(toMatrix(input));
  if (!matrix.length) {
    return { contacts: [], headers: [], mapping: { firstName: null, lastName: null, fullName: null, phone: null }, hasHeader: false, stats: { total: 0, ok: 0, invalid: 0, duplicate: 0 } };
  }
  const hasHeader = typeof options.hasHeader === 'boolean' ? options.hasHeader : detectHeader(matrix);
  const width = Math.max(...matrix.map(r => r.length));
  let headers = hasHeader ? matrix[0].map((h, i) => (isBlank(h) ? `Column ${i + 1}` : String(h).trim())) : positionalHeaders(width);
  // De-duplicate header names.
  const seenHeaders = new Map();
  headers = headers.map(h => {
    const n = seenHeaders.get(h) || 0;
    seenHeaders.set(h, n + 1);
    return n ? `${h} (${n + 1})` : h;
  });
  const rows = hasHeader ? matrix.slice(1) : matrix;

  let mapping = detectMapping(headers, rows, hasHeader);
  if (options.mapping && typeof options.mapping === 'object') {
    for (const role of ['firstName', 'lastName', 'fullName', 'phone']) {
      if (role in options.mapping) {
        const v = options.mapping[role];
        mapping[role] = v && headers.includes(v) ? v : null;
      }
    }
  }
  const col = name => (name ? headers.indexOf(name) : -1);
  const idx = { firstName: col(mapping.firstName), lastName: col(mapping.lastName), fullName: col(mapping.fullName), phone: col(mapping.phone) };
  const roleCols = new Set(Object.values(idx).filter(i => i >= 0));
  const extraHeaders = headers.filter((h, i) => !roleCols.has(i));

  const contacts = [];
  const seenPhones = new Map();
  rows.forEach((row, i) => {
    const get = c => (c >= 0 && row[c] !== undefined ? String(row[c]).trim() : '');
    let firstName = get(idx.firstName);
    let lastName = get(idx.lastName);
    if (!firstName && !lastName && idx.fullName >= 0) {
      const split = splitFullName(get(idx.fullName));
      firstName = split.firstName; lastName = split.lastName;
    }
    if (options.prettifyNames !== false) {
      firstName = titleCaseIfShouting(firstName);
      lastName = titleCaseIfShouting(lastName);
    }
    const extra = {};
    headers.forEach((h, c) => { if (!roleCols.has(c)) extra[h] = row[c] === undefined ? '' : String(row[c]).trim(); });

    const rawPhone = idx.phone >= 0 ? row[idx.phone] : '';
    const phone = normalizePhone(rawPhone, defaultCountry);
    const contact = {
      id: `c${i + 1}`,
      row: i + (hasHeader ? 2 : 1),
      firstName,
      lastName,
      rawPhone: toRawString(rawPhone),
      phone: phone.ok ? phone.digits : null,
      e164: phone.ok ? phone.e164 : null,
      phoneDisplay: phone.ok ? phone.display : toRawString(rawPhone),
      country: phone.ok ? phone.country : null,
      phoneValid: phone.ok ? phone.valid : false,
      status: 'ok',
      reason: null,
      extra,
    };
    if (!phone.ok) {
      contact.status = 'invalid';
      contact.reason = idx.phone < 0 ? 'no phone column' : phone.reason;
    } else if (seenPhones.has(phone.digits)) {
      contact.status = 'duplicate';
      contact.reason = `same number as row ${seenPhones.get(phone.digits)}`;
    } else {
      seenPhones.set(phone.digits, contact.row);
      if (!phone.valid) contact.reason = 'unusual length for this country, will be checked on WhatsApp';
    }
    contacts.push(contact);
  });

  const stats = {
    total: contacts.length,
    ok: contacts.filter(c => c.status === 'ok').length,
    invalid: contacts.filter(c => c.status === 'invalid').length,
    duplicate: contacts.filter(c => c.status === 'duplicate').length,
  };
  return { contacts, headers, extraHeaders, mapping, hasHeader, stats };
}

module.exports = { parseContacts, detectMapping, detectHeader, splitFullName, toMatrix, decodeText };
