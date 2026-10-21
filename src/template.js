'use strict';

// Lower-case, strip accents and anything that is not a letter or digit:
// "Prénom de l'élève" -> "prenomdeleleve". Used to match headers and placeholders.
function normKey(key) {
  return String(key === undefined || key === null ? '' : key)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Placeholder spellings people are likely to type, mapped to the canonical field.
const ALIASES = {
  firstname: 'firstname', first: 'firstname', prenom: 'firstname', prenoms: 'firstname',
  givenname: 'firstname', forename: 'firstname', name: 'firstname',
  lastname: 'lastname', last: 'lastname', surname: 'lastname', nom: 'lastname',
  familyname: 'lastname', nomdefamille: 'lastname', famille: 'lastname',
  fullname: 'fullname', nomcomplet: 'fullname', nomprenom: 'fullname', prenomnom: 'fullname',
  phone: 'phone', telephone: 'phone', tel: 'phone', numero: 'phone', mobile: 'phone',
  whatsapp: 'phone', number: 'phone',
};

const BUILTIN_PLACEHOLDERS = ['firstName', 'lastName', 'fullName', 'phone'];

function buildVars(contact) {
  const vars = {};
  const extra = contact && contact.extra ? contact.extra : {};
  for (const [k, v] of Object.entries(extra)) {
    const nk = normKey(k);
    if (nk) vars[nk] = v;
  }
  const firstName = (contact && contact.firstName) || '';
  const lastName = (contact && contact.lastName) || '';
  vars.firstname = firstName;
  vars.lastname = lastName;
  vars.fullname = [firstName, lastName].filter(Boolean).join(' ');
  vars.phone = (contact && (contact.phoneDisplay || contact.e164 || contact.phone)) || '';
  return vars;
}

// {{ key }} or {{ key | fallback text }}
const PLACEHOLDER_RE = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

// Column names people use for Mr / Mrs / Dr, most specific first.
const TITLE_KEYS = ['prefix', 'civilite', 'civility', 'salutation', 'titre', 'title'];

// Invisible characters that make a cell look filled although it shows nothing.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;

/** The value as text, or null when it is effectively empty. */
function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\u0000/g, '');
  return s.replace(INVISIBLE, '').trim() === '' ? null : s;
}

/**
 * Render a message template for one contact.
 * Returns { text, missing, leftover } where missing lists placeholders that had
 * no value (each once) and leftover is true when "{{" or "}}" remain in the text.
 */
function render(template, contact) {
  const vars = buildVars(contact);
  const missing = [];
  const missingKeys = new Set();
  const raw = String(template === undefined || template === null ? '' : template)
    .replace(PLACEHOLDER_RE, (match, key, fallback) => {
      const nk = normKey(key);
      const canonical = ALIASES[nk] || nk;
      let value = vars[canonical];
      if (value === undefined) value = vars[nk];
      // {{title}}, {{civilité}}, {{prefix}}... reach whichever title column the file has.
      if (value === undefined && TITLE_KEYS.includes(nk)) {
        const k = TITLE_KEYS.find(t => cleanValue(vars[t]) !== null);
        if (k) value = vars[k];
      }
      const text = cleanValue(value);
      if (text === null) {
        if (fallback !== undefined && fallback !== '') return fallback;
        if (fallback === undefined && !missingKeys.has(canonical)) {
          missingKeys.add(canonical);
          missing.push(key.trim());
        }
        return EMPTY;
      }
      return text;
    });
  const text = tidyEmpty(raw);
  return { text, missing, leftover: /\{\{|\}\}/.test(text) };
}

// Marks where a placeholder rendered empty, so the spaces around it can be tidied:
// "Dear {{Prefix}} {{lastName}}" with no prefix gives "Dear Khoury", not "Dear  Khoury".
const EMPTY = '\u0000';
const SP = '[ \\t\\u00A0\\u202F]';                                  // spaces, tabs, French non-breaking spaces
const CLOSE = '[,.;:!?)\\]}"\'»”’…*_~\\u060C\\u061B\\u061F]';      // punctuation, closing marks, WhatsApp *bold* _italic_ ~strike~, Arabic ، ؛ ؟
const OPEN = '[(\\[{"«“‘*_~]';
const TIDY = [
  // A line that holds only empty placeholders disappears entirely.
  [new RegExp(`^${SP}*(?:\\u0000${SP}*)+(?:\\r?\\n|$)`, 'gm'), ''],
  // "Hello _," -> "Hello,"   "*Bonjour _*" -> "*Bonjour*"   (runs of empties too)
  [new RegExp(`(?:${SP}+\\u0000)+(?=${CLOSE}|\\r?\\n|$)`, 'g'), ''],
  // "Dear _ Khoury" -> "Dear Khoury": keep the author's space on the left, drop the one on the right.
  [new RegExp(`(?<=${SP})\\u0000${SP}*`, 'g'), ''],
  // "_ Khoury" at the start of a line, or after an opening mark: "*_ Saad*" -> "*Saad*".
  [new RegExp(`(^|${OPEN})\\u0000${SP}+`, 'gm'), '$1'],
  [/\u0000/g, ''],
];
function tidyEmpty(text) {
  return TIDY.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

/** Every placeholder use: { key, nk, hasFallback } in order of appearance. */
function placeholderUses(template) {
  const uses = [];
  let m;
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  while ((m = re.exec(String(template || ''))) !== null) {
    const key = m[1].trim();
    uses.push({ key, nk: normKey(key), hasFallback: m[2] !== undefined && m[2] !== '' });
  }
  return uses;
}

/** List the distinct placeholder names used in a template, in order of appearance. */
function placeholders(template) {
  const found = [];
  const seen = new Set();
  for (const u of placeholderUses(template)) {
    if (!seen.has(u.nk)) { seen.add(u.nk); found.push(u.key); }
  }
  return found;
}

/**
 * Placeholders that neither the built-in fields nor the extra columns can fill.
 * A placeholder that always has a fallback ({{Prefix|colleague}}) is not
 * reported: the fallback text is what gets sent.
 */
function unknownPlaceholders(template, extraColumns = []) {
  const extra = extraColumns.map(normKey);
  const known = new Set([...BUILTIN_PLACEHOLDERS.map(normKey), ...Object.keys(ALIASES), ...extra]);
  if (extra.some(k => TITLE_KEYS.includes(k))) TITLE_KEYS.forEach(k => known.add(k));
  const uses = placeholderUses(template);
  return placeholders(template).filter(p => {
    const nk = normKey(p);
    if (known.has(nk)) return false;
    return uses.some(u => u.nk === nk && !u.hasFallback);
  });
}

module.exports = { render, placeholders, placeholderUses, unknownPlaceholders, normKey, ALIASES, BUILTIN_PLACEHOLDERS, TITLE_KEYS };
