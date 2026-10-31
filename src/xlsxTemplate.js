'use strict';
const XLSX = require('xlsx');
const { parseContacts } = require('./contacts');
const { normKey, ALIASES, TITLE_KEYS } = require('./template');

// The fixed columns of the downloadable Excel template, in order.
const BASE_HEADERS = ['Prefix', 'First Name', 'Last Name', 'Country Code', 'WhatsApp Number'];
const EXAMPLE = ['Mrs', 'Rita', 'Khoury', '961', '70 123 456'];
const MAX_VARIABLES = 20;
const MAX_NAME_LENGTH = 40;
const TEXT_ROWS = 2000; // rows pre-formatted as text so Excel keeps leading zeros and "+"

const RESERVED = new Set([
  ...BASE_HEADERS.map(normKey),
  ...Object.keys(ALIASES),
  ...TITLE_KEYS,
  'firstname', 'lastname', 'fullname', 'phone',
]);

function defaultName(i) {
  return `Variable ${i + 1}`;
}

/**
 * Check the variable names and fill in defaults. Returns { names } or throws a
 * 400 error explaining which name cannot be used.
 */
function cleanVariableNames(count, names) {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 0 || n > MAX_VARIABLES) {
    throw badRequest(`Choose between 0 and ${MAX_VARIABLES} variables`);
  }
  const list = Array.isArray(names) ? names : [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const raw = String(list[i] === undefined || list[i] === null ? '' : list[i])
      .replace(/[{}|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
    const name = (raw || defaultName(i)).slice(0, MAX_NAME_LENGTH).trim();
    const key = normKey(name);
    if (!key) throw badRequest(`Variable ${i + 1}: the name needs at least one letter or digit`);
    if (RESERVED.has(key)) throw badRequest(`"${name}" is already a standard column, choose another name`);
    if (seen.has(key)) throw badRequest(`"${name}" is used twice, each variable needs its own name`);
    if (!importsAsVariable(name)) {
      throw badRequest(`"${name}" would be mistaken for a name or phone column when importing, choose another name`);
    }
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Make sure the importer maps the standard columns as intended and keeps this
// column as an extra placeholder, even if the user fills it with digits.
function importsAsVariable(name) {
  const headers = [...BASE_HEADERS, name];
  for (const value of ['abc', '70 000 009']) {
    const rows = [headers, [...EXAMPLE, value], ['Mr', 'Pierre', 'Martin', '33', '6 00 00 00 02', value]];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const res = parseContacts({ text: csv }, { defaultCountry: 'LB' });
    const m = res.mapping;
    const ok = res.hasHeader
      && m.firstName === 'First Name' && m.lastName === 'Last Name'
      && m.phone === 'WhatsApp Number' && m.countryCode === 'Country Code'
      && res.extraHeaders.includes(name);
    if (!ok) return false;
  }
  return true;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Build the template workbook and return it as an .xlsx buffer. */
function buildTemplate(variableNames) {
  const headers = [...BASE_HEADERS, ...variableNames];
  const ws = XLSX.utils.aoa_to_sheet([headers]);

  // Text format for the number columns so "03 123 456" and "+961..." survive as typed.
  const textCols = [BASE_HEADERS.indexOf('Country Code'), BASE_HEADERS.indexOf('WhatsApp Number')];
  for (let r = 1; r <= TEXT_ROWS; r++) {
    for (const c of textCols) ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: '', z: '@' };
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: TEXT_ROWS, c: headers.length - 1 } });
  ws['!cols'] = headers.map(h => ({ wch: Math.max(14, h.length + 4) }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }) };

  const help = [
    ['How to fill the Contacts sheet'],
    [],
    ['One person per row. Keep the first row (the column names) as it is.'],
    [],
    ['Column', 'What to write', 'Example', 'Placeholder in the message'],
    ['Prefix', 'Optional title (Mr, Mrs, Dr...)', EXAMPLE[0], '{{Prefix}}'],
    ['First Name', 'First name', EXAMPLE[1], '{{firstName}}'],
    ['Last Name', 'Last name', EXAMPLE[2], '{{lastName}}'],
    ['Country Code', 'Optional. Dialing code without + (961, 33...). Empty = the default country chosen in the app', EXAMPLE[3], ''],
    ['WhatsApp Number', 'The WhatsApp number, local or international (+961 70 123 456)', EXAMPLE[4], '{{phone}}'],
    ...variableNames.map(name => [name, 'Your own information for this person', '', `{{${name}}}`]),
    [],
    ['Example message:'],
    [`Bonjour {{Prefix}} {{lastName}},${variableNames.length ? ` ... {{${variableNames[0]}}} ...` : ''}`],
    [],
    ['Save the file, then drop it in step 2 "Contacts" of the app.'],
  ];
  const helpWs = XLSX.utils.aoa_to_sheet(help);
  helpWs['!cols'] = [{ wch: 22 }, { wch: 70 }, { wch: 16 }, { wch: 28 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts'); // first sheet: the one the importer reads
  XLSX.utils.book_append_sheet(wb, helpWs, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildTemplate, cleanVariableNames, BASE_HEADERS, MAX_VARIABLES };
