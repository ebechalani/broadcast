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

// ----- Text variations: "{Bonjour|Bonsoir|Cher collègue}" -----
// A single-brace group with at least one "|" is replaced by one of its options.
// Groups can be nested and can contain {{placeholders}}; "{{...}}" is never a group,
// and braces without "|" ("{world}") stay as written.

/** For a "{" at `start` (not "{{"), the group's end index and its options, or null. */
function readGroup(s, start) {
  let depth = 0;
  let partStart = start + 1;
  const parts = [];
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' && s[i + 1] === '{' && i !== start) {
      const close = s.indexOf('}}', i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) { parts.push(s.slice(partStart, i)); return { end: i, parts }; }
      continue;
    }
    if (ch === '|' && depth === 1) { parts.push(s.slice(partStart, i)); partStart = i + 1; }
  }
  return null;
}

/**
 * Walk the template; onGroup(parts, before, after) returns the replacement for
 * each variation group, where before/after are the characters just outside it.
 */
function walkVariations(s, onGroup) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' && s[i + 1] === '{') {
      const close = s.indexOf('}}', i + 2);
      if (close < 0) { out += s.slice(i); break; }
      out += s.slice(i, close + 2);
      i = close + 1;
      continue;
    }
    if (ch === '{') {
      const g = readGroup(s, i);
      if (g && g.parts.length > 1) {
        out += onGroup(g.parts, out[out.length - 1], s[g.end + 1]);
        i = g.end;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

const isGap = ch => ch === undefined || /[\s\u0000]/.test(ch);

function expandVariations(s, rand) {
  return walkVariations(s, (parts, before, after) => {
    const pick = parts[Math.floor(rand() * parts.length)];
    const expanded = expandVariations(pick, rand);
    const core = expanded.replace(/^[ \t]+|[ \t]+$/g, '');
    if (core === '') return EMPTY; // an empty option is tidied like an empty placeholder
    // Spaces next to "|" are just formatting ("{Bonjour | Salut}"), but a space at the edge
    // of an option is kept when the text outside has none ("17h.{| Merci de confirmer.}").
    const lead = /^[ \t]/.test(expanded) && !isGap(before) ? ' ' : '';
    const trail = /[ \t]$/.test(expanded) && !isGap(after) ? ' ' : '';
    return lead + core + trail;
  });
}

/** How many different texts the variations can produce (capped). */
function countVariations(template) {
  const CAP = 1e9;
  let total = 1;
  walkVariations(String(template || ''), parts => {
    const n = parts.reduce((sum, p) => sum + countVariations(p), 0);
    total = Math.min(CAP, total * n);
    return '';
  });
  return total;
}

/** Deterministic random numbers from a text seed (FNV-1a hash + mulberry32). */
function seededRandom(seed) {
  let h = 2166136261 >>> 0;
  for (const c of String(seed)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  let a = h || 1;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Render a message template for one contact.
 * Returns { text, missing, leftover } where missing lists placeholders that had
 * no value (each once) and leftover is true when "{{", "}}" or an unfinished
 * "{a|b" variation remain in the text.
 * Variations are picked per contact: the same teacher always gets the same
 * version of a given message, so the preview shows exactly what is sent.
 */
function render(template, contact) {
  const vars = buildVars(contact);
  const missing = [];
  const missingKeys = new Set();
  const source = String(template === undefined || template === null ? '' : template);
  const c = contact || {};
  const rand = seededRandom(`${c.phone || c.e164 || c.id || ''}|${c.firstName || ''}|${c.lastName || ''}|${source}`);
  const raw = expandVariations(source, rand)
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
  return { text, missing, leftover: /\{\{|\}\}|\{[^{}]*\|/.test(text) };
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

module.exports = { render, placeholders, placeholderUses, unknownPlaceholders, countVariations, normKey, ALIASES, BUILTIN_PLACEHOLDERS, TITLE_KEYS };
