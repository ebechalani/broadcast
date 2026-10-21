'use strict';
const Papa = require('papaparse');
const XLSX = require('xlsx');
const { getCountries, getCountryCallingCode } = require('libphonenumber-js/max');
const { normalizePhone, looksLikePhone, toRawString } = require('./phone');

// Every real country calling code (961, 33, 1, ...): anything else is not a country code.
const CALLING_CODES = new Set(getCountries().map(c => String(getCountryCallingCode(c))));
const { normKey } = require('./template');

const FIRST_NAMES = ['firstname', 'first', 'prenom', 'prenoms', 'givenname', 'forename', 'firstnames', 'prenomeleve', 'prenomparent'];
const LAST_NAMES = ['lastname', 'last', 'surname', 'nom', 'noms', 'famille', 'nomdefamille', 'familyname', 'family', 'nomeleve', 'nomparent'];
const FULL_NAMES = ['name', 'fullname', 'nomcomplet', 'nomprenom', 'prenomnom', 'nometprenom', 'prenometnom', 'contact', 'eleve', 'student', 'parent', 'personne'];
const PHONES = ['phone', 'phonenumber', 'telephone', 'tel', 'numero', 'numerodetelephone', 'mobile', 'whatsapp', 'whatsappnumber', 'number', 'gsm', 'cell', 'cellphone', 'portable', 'numwhatsapp', 'mobilephone', 'telwhatsapp', 'numerowhatsapp'];

// "(^|[^a])tel" keeps "Atelier" out while matching "Tel", "Téléphone", "Tél. parent". "whatsap" also catches truncated/typo headers.
const PHONE_FUZZY = /(whatsap|phone|mobile|numero|gsm|portable|cell|(^|[^a])tel)/;
// An optional column holding the country calling code: "Country Code", "Code pays", "Indicatif".
// "Prefix" on its own is NOT one of them: in these lists it holds the title (Mr, Mrs).
const COUNTRY_CODE_NAMES = ['countrycode', 'countrycodes', 'codepays', 'codedupays', 'indicatif', 'indicatifpays', 'dialcode', 'dialingcode', 'callingcode', 'countrycallingcode', 'countryprefix', 'phoneprefix', 'phonecountrycode', 'phonecode', 'telcode', 'prefixepays', 'prefixpays'];
const COUNTRY_CODE_FUZZY = /(countrycode|codepays|codedupays|indicatif|dialcode|dialingcode|callingcode|countryprefix|phoneprefix|phonecode|telcode|prefixepays|prefixpays)/;
// Generic headers that are only taken as the country code when most cells hold one.
const GENERIC_CODE_NAMES = ['country', 'cc', 'code', 'pays'];
// Headers of a title column (Mr, Mrs): never a country code.
const TITLE_HEADER_KEYS = ['prefix', 'prefixe', 'prefixes', 'title', 'titre', 'civilite', 'civility', 'salutation'];
// Cell values of a title column.
const TITLE_VALUE = /^(mr|mrs|ms|miss|mme|mlle|m|dr|pr|prof|madame|monsieur|mademoiselle|sir|madam|docteur|doctor|me)\.?$/i;
const DIAL_CODE = /^(\+|00)?\d{1,4}$/;
const FIRST_FUZZY = /(prenom|first|given)/;
const LAST_FUZZY = /(surname|lastname|^last|^famille$|nomdefamille|familyname)/;
// One column holding the whole name: "Nom et Prénom", "Nom Prénom", "Prénom Nom", "Nom complet".
const COMBINED_NAME = /(nom.*prenom|prenom.*nom|fullname|nomcomplet)/;
const ALL_KEYWORDS = new Set([...FIRST_NAMES, ...LAST_NAMES, ...FULL_NAMES, ...PHONES]);
// Header cells usually start with or contain one of these.
const HEADER_HINT = /^(tel|nom|prenom|numero|mobile|whatsapp|phone|first|last|surname|name|gsm|portable|contact|eleve|parent|classe|email|mail)|(whatsapp|phone|mobile|numero|telephone|prenom|surname|lastname|firstname)/;

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls|ods|xlsb)$/i;
const MAX_ROWS = 50000;

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function cellToString(v) {
  if (typeof v === 'number') return toRawString(v);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(v.getDate())}/${p(v.getMonth() + 1)}/${v.getFullYear()}`;
  }
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

/** Turn an uploaded file or pasted text into a matrix of strings (rows x columns), blank rows included. */
function toMatrix({ buffer, filename, text }) {
  if (buffer && filename && SPREADSHEET_EXT.test(filename)) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return [];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
    return rows.map(r => r.map(cellToString));
  }
  let csv = text;
  if (csv === undefined || csv === null) {
    csv = buffer ? decodeText(buffer) : '';
  }
  csv = String(csv).replace(/^﻿/, '');
  if (!csv.trim()) return [];
  // Guess the delimiter on the non-empty lines (blank lines would skew the guess),
  // then parse everything, blank lines included, so row numbers match the file.
  const probe = Papa.parse(csv.slice(0, 100000), { header: false, skipEmptyLines: 'greedy', preview: 50, delimitersToGuess: [',', ';', '\t', '|'] });
  const delimiter = (probe.meta && probe.meta.delimiter) || ';';
  const result = Papa.parse(csv, { header: false, skipEmptyLines: false, delimiter });
  const rows = result.data.map(r => r.map(cellToString));
  // Drop the empty row a trailing newline produces.
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

/** Remove blank rows and columns but remember each row's original (0-based) index. */
function compact(matrix) {
  const kept = [];
  matrix.forEach((r, i) => { if (r.some(c => !isBlank(c))) kept.push({ cells: r, src: i }); });
  if (!kept.length) return { rows: [], srcRows: [] };
  const width = kept.reduce((w, r) => Math.max(w, r.cells.length), 0);
  const keepCols = [];
  for (let c = 0; c < width; c++) {
    if (kept.some(r => !isBlank(r.cells[c]))) keepCols.push(c);
  }
  return {
    rows: kept.map(r => keepCols.map(c => (r.cells[c] === undefined ? '' : r.cells[c]))),
    srcRows: kept.map(r => r.src),
  };
}

function headerScore(row) {
  let score = 0;
  for (const cell of row) {
    if (isBlank(cell) || looksLikePhone(cell)) continue;
    const key = normKey(cell);
    if (!key) continue;
    if (ALL_KEYWORDS.has(key) || HEADER_HINT.test(key)) score++;
  }
  return score;
}

/**
 * Find the header row among the first rows: the one with the most header-like
 * words (school exports often start with a title row). Returns -1 when the
 * data has no header.
 */
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 10);
  let best = -1, bestScore = 0;
  for (let i = 0; i < limit; i++) {
    if (rows[i].some(looksLikePhone)) continue;
    const s = headerScore(rows[i]);
    if (s > bestScore) { best = i; bestScore = s; }
  }
  if (best >= 0) return best;
  // No recognisable header words: a first row without any phone is still most likely a header.
  if (rows.length > 1 && !rows[0].some(looksLikePhone)) return 0;
  return -1;
}

/** Kept for compatibility: true when the first row looks like a header. */
function detectHeader(rows) {
  return findHeaderRow(rows) >= 0;
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

/** "+961", "00961", "961" -> "961"; anything else (e.g. "Mr") -> null. */
function dialCodeDigits(value) {
  let s = toRawString(value).replace(/\p{Cf}/gu, '').trim();
  s = s.replace(/\.0+$/, '');                              // "33.0" from a float export
  s = s.replace(/[\s(]*\p{L}[\p{L}\s.'()-]*$/u, '');       // "+33 (France)", "961 Liban"
  s = s.replace(/[\s\u00A0().-]/g, '');
  if (!DIAL_CODE.test(s)) return null;
  const d = s.replace(/^(\+|00)/, '').replace(/^0+/, '');
  if (!d) return null;
  // Real calling codes only; 1xxx covers the North American area-code style (1876 Jamaica).
  return CALLING_CODES.has(d) || /^1\d{3}$/.test(d) ? d : null;
}

function titleScore(rows, col) {
  let hits = 0, total = 0;
  for (const r of rows) {
    if (isBlank(r[col])) continue;
    total++;
    if (TITLE_VALUE.test(String(r[col]).trim())) hits++;
  }
  return total ? hits / total : 0;
}

function dialCodeScore(rows, col) {
  let hits = 0, total = 0;
  for (const r of rows) {
    if (isBlank(r[col])) continue;
    total++;
    if (dialCodeDigits(r[col])) hits++;
  }
  return total ? hits / total : 0;
}

/**
 * Work out which column holds which field.
 * Returns { firstName, lastName, fullName, phone, phoneFallbacks } with header names (or null).
 */
function detectMapping(headers, rows, hasHeader) {
  const norm = headers.map((h, i) => ({ raw: h, key: normKey(h), i }));
  const score = i => phoneScore(rows, i);

  // Phone: columns named like a phone, but only if their content agrees
  // ("Numéro" is often a row index, "WhatsApp" often holds oui/non).
  let phone = null;
  const byName = [
    ...norm.filter(h => PHONES.includes(h.key)),
    ...norm.filter(h => !PHONES.includes(h.key) && PHONE_FUZZY.test(h.key)),
  ];
  if (hasHeader) {
    const hit = byName.find(h => score(h.i) >= 0.5);
    phone = hit ? hit.raw : null;
  }
  if (!phone) phone = guessPhoneColumn(headers, rows);
  if (!phone && hasHeader && byName.length) phone = byName[0].raw;

  let firstName = null, lastName = null, fullName = null;
  if (hasHeader) {
    const free = h => h.raw !== phone;
    const notCombined = h => !COMBINED_NAME.test(h.key);
    const exact = list => norm.find(h => free(h) && list.includes(h.key) && notCombined(h));

    const f = exact(FIRST_NAMES) || norm.find(h => free(h) && notCombined(h) && FIRST_FUZZY.test(h.key));
    firstName = f ? f.raw : null;

    let l = exact(LAST_NAMES) || norm.find(h => free(h) && h.raw !== firstName && notCombined(h) && LAST_FUZZY.test(h.key));
    if (!l) {
      // "Nom", "Nom de l'élève", "Nom du père": prefer the one that mirrors the first-name column.
      const nomCols = norm.filter(h => free(h) && h.raw !== firstName && notCombined(h) && /^noms?(?!bre)/.test(h.key));
      if (nomCols.length) {
        const suffix = firstName ? normKey(firstName).replace(/^prenoms?/, '') : null;
        l = (suffix !== null && nomCols.find(h => h.key.replace(/^noms?/, '') === suffix)) || nomCols[0];
      }
    }
    lastName = l ? l.raw : null;

    // "Nom" alone, without a first-name column, is usually the full name.
    if (lastName && !firstName && /^noms?$/.test(normKey(lastName))) {
      fullName = lastName; lastName = null;
    }
    // "Name" next to a "Last Name" column is the first name.
    if (lastName && !firstName) {
      const n = norm.find(h => free(h) && h.raw !== lastName && ['name', 'names', 'nom', 'prenom'].includes(h.key));
      if (n) firstName = n.raw;
    }
    if (!firstName && !lastName && !fullName) {
      const full = norm.find(h => free(h) && COMBINED_NAME.test(h.key))
        || norm.find(h => free(h) && FULL_NAMES.includes(h.key))
        || norm.find(h => free(h) && /(name|nom|eleve|student|parent|contact)/.test(h.key));
      fullName = full ? full.raw : null;
    }
  }

  if (!hasHeader || (!firstName && !lastName && !fullName)) {
    // Positional fallback: the non-phone, mostly-text columns in order.
    const textCols = headers.filter(h => h !== phone && h !== fullName && h !== firstName && h !== lastName)
      .filter(h => phoneScore(rows, headers.indexOf(h)) < 0.5)
      .filter(h => titleScore(rows, headers.indexOf(h)) < 0.5) // a Mr/Mrs column is not a name
      .filter(h => rows.some(r => !isBlank(r[headers.indexOf(h)]) && /[A-Za-zÀ-ɏ؀-ۿ]/.test(r[headers.indexOf(h)])));
    if (!firstName && !lastName && !fullName) {
      if (textCols.length >= 2) { firstName = textCols[0]; lastName = textCols[1]; }
      else if (textCols.length === 1) { fullName = textCols[0]; }
    }
  }

  // Country-code column: named like one AND holding dialing codes. Other
  // columns (Prefix with Mr/Mrs, School, ...) stay usable as placeholders.
  let countryCode = null;
  if (hasHeader) {
    const eligible = h => h.raw !== phone && !TITLE_HEADER_KEYS.includes(h.key);
    // A clearly named column is used as soon as some cells hold a code (the rest keep the default country);
    // a generic one ("Country", "Code") only when most of its cells are codes.
    const cand = norm.find(h => eligible(h) && (COUNTRY_CODE_NAMES.includes(h.key) || COUNTRY_CODE_FUZZY.test(h.key)) && dialCodeScore(rows, h.i) > 0)
      || norm.find(h => eligible(h) && GENERIC_CODE_NAMES.includes(h.key) && dialCodeScore(rows, h.i) >= 0.5);
    countryCode = cand ? cand.raw : null;
  }

  // A column may only play one role.
  const picked = { phone, countryCode, firstName, lastName, fullName };
  const used = new Set();
  for (const role of ['phone', 'countryCode', 'firstName', 'lastName', 'fullName']) {
    if (picked[role] && used.has(picked[role])) picked[role] = null;
    if (picked[role]) used.add(picked[role]);
  }

  // Other columns that hold numbers ("Mobile Mère" next to "Mobile Père") are used when the main one is empty.
  picked.phoneFallbacks = norm
    .filter(h => !used.has(h.raw) && score(h.i) >= 0.5)
    .map(h => h.raw);
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

const EMPTY_MAPPING = { firstName: null, lastName: null, fullName: null, phone: null, countryCode: null, phoneFallbacks: [] };
const ROLES = ['firstName', 'lastName', 'fullName', 'phone', 'countryCode'];

/**
 * Parse an upload into contacts.
 * @param {{buffer?: Buffer, filename?: string, text?: string}} input
 * @param {{defaultCountry?: string, mapping?: object, hasHeader?: boolean|null, prettifyNames?: boolean}} options
 */
function parseContacts(input, options = {}) {
  const defaultCountry = (options.defaultCountry || 'LB').toUpperCase();
  const { rows: all, srcRows: allSrc } = compact(toMatrix(input));
  if (!all.length) {
    return { contacts: [], headers: [], extraHeaders: [], mapping: { ...EMPTY_MAPPING }, hasHeader: false, headerRow: null, stats: { total: 0, ok: 0, invalid: 0, duplicate: 0 } };
  }
  if (all.length > MAX_ROWS) {
    const err = new Error(`Too many rows (${all.length}). The limit is ${MAX_ROWS}; split the file.`);
    err.status = 413;
    throw err;
  }

  let headerIndex;
  if (typeof options.hasHeader === 'boolean') {
    headerIndex = options.hasHeader ? Math.max(0, findHeaderRow(all)) : -1;
  } else {
    headerIndex = findHeaderRow(all);
  }
  const hasHeader = headerIndex >= 0;
  const rows = hasHeader ? all.slice(headerIndex + 1) : all;
  const srcRows = hasHeader ? allSrc.slice(headerIndex + 1) : allSrc;
  const width = all.reduce((w, r) => Math.max(w, r.length), 0);

  let headers = hasHeader
    ? all[headerIndex].map((h, i) => (isBlank(h) ? `Column ${i + 1}` : String(h).trim()))
    : positionalHeaders(width);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  // De-duplicate header names.
  const seenHeaders = new Map();
  headers = headers.map(h => {
    const n = seenHeaders.get(h) || 0;
    seenHeaders.set(h, n + 1);
    return n ? `${h} (${n + 1})` : h;
  });

  const mapping = detectMapping(headers, rows, hasHeader);
  if (options.mapping && typeof options.mapping === 'object') {
    for (const role of ROLES) {
      if (!(role in options.mapping)) continue;
      const v = options.mapping[role];
      // null clears the role; a name that no longer exists (header toggled) keeps the detection.
      if (v === null || v === '') { mapping[role] = null; continue; }
      if (!headers.includes(v)) continue;
      if (role === 'countryCode') {
        // The title column (Mr, Mrs) or a column without any code cannot be the country code.
        const ci = headers.indexOf(v);
        if (TITLE_HEADER_KEYS.includes(normKey(v)) || !rows.some(r => dialCodeDigits(r[ci]))) continue;
      }
      mapping[role] = v;
    }
    const chosen = new Set(ROLES.map(r => mapping[r]).filter(Boolean));
    mapping.phoneFallbacks = (mapping.phoneFallbacks || []).filter(h => !chosen.has(h));
  }

  const col = name => (name ? headers.indexOf(name) : -1);
  const idx = { firstName: col(mapping.firstName), lastName: col(mapping.lastName), fullName: col(mapping.fullName), phone: col(mapping.phone), countryCode: col(mapping.countryCode) };
  const fallbackIdx = (mapping.phoneFallbacks || []).map(col).filter(i => i >= 0);
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

    // Main phone column first, then any other column that holds numbers.
    // A country-code column ("Country Code": 961) is put in front of numbers written without one.
    const codeDigits = idx.countryCode >= 0 ? dialCodeDigits(row[idx.countryCode]) : null;
    const withPrefix = raw => {
      const s = toRawString(raw).replace(/\p{Cf}/gu, '').trim().replace(/^[‘’'"`]+/, '');
      if (!codeDigits || /^(\+|00)/.test(s)) return null;
      // Already written with its own code but no "+" (971501234567 with code 971): do not add it twice.
      const digits = s.replace(/\D/g, '');
      if (digits.startsWith(codeDigits)) {
        const asIs = normalizePhone(`+${digits}`, defaultCountry);
        if (asIs.ok && asIs.valid) return null;
      }
      return `+${codeDigits}${s}`;
    };
    const candidates = [idx.phone, ...fallbackIdx].filter(c => c >= 0);
    let phone = null, firstAttempt = null, usedCol = -1, rawPhone = '';
    for (const c of candidates) {
      const raw = row[c];
      if (isBlank(raw)) continue;
      const prefixed = withPrefix(raw);
      let r = prefixed ? normalizePhone(prefixed, defaultCountry) : null;
      if (!r || !r.ok || !r.valid) {
        // The code did not give a valid number: use the number as written if that one is valid.
        const plain = normalizePhone(raw, defaultCountry);
        if (!r || !r.ok || (plain.ok && plain.valid)) r = plain;
      }
      if (!firstAttempt) { firstAttempt = r; rawPhone = toRawString(raw); }
      if (r.ok) { phone = r; usedCol = c; rawPhone = toRawString(raw); break; }
    }
    if (!phone) phone = firstAttempt || { ok: false, reason: 'empty', input: '' };
    const rowNumber = (srcRows[i] !== undefined ? srcRows[i] : i) + 1;

    const contact = {
      id: `c${i + 1}`,
      row: rowNumber,
      firstName,
      lastName,
      rawPhone,
      phone: phone.ok ? phone.digits : null,
      e164: phone.ok ? phone.e164 : null,
      phoneDisplay: phone.ok ? phone.display : rawPhone,
      phoneSource: phone.ok && usedCol >= 0 && usedCol !== idx.phone ? headers[usedCol] : null,
      country: phone.ok ? phone.country : null,
      phoneValid: phone.ok ? phone.valid : false,
      status: 'ok',
      reason: null,
      extra,
    };
    if (!phone.ok) {
      contact.status = 'invalid';
      contact.reason = idx.phone < 0 && !fallbackIdx.length ? 'no phone column' : phone.reason;
    } else if (seenPhones.has(phone.digits)) {
      contact.status = 'duplicate';
      contact.reason = `same number as row ${seenPhones.get(phone.digits)}`;
    } else {
      seenPhones.set(phone.digits, contact.row);
      const notes = [];
      if (contact.phoneSource) notes.push(`number taken from "${contact.phoneSource}"`);
      if (phone.note) notes.push(phone.note);
      if (!phone.valid) notes.push('unusual length for this country, will be checked on WhatsApp');
      contact.reason = notes.length ? notes.join('; ') : null;
    }
    contacts.push(contact);
  });

  const stats = {
    total: contacts.length,
    ok: contacts.filter(c => c.status === 'ok').length,
    invalid: contacts.filter(c => c.status === 'invalid').length,
    duplicate: contacts.filter(c => c.status === 'duplicate').length,
  };
  return {
    contacts,
    headers,
    extraHeaders,
    mapping,
    hasHeader,
    headerRow: hasHeader ? allSrc[headerIndex] + 1 : null,
    stats,
  };
}

module.exports = { parseContacts, detectMapping, detectHeader, findHeaderRow, splitFullName, toMatrix, decodeText, dialCodeDigits, ROLES };
