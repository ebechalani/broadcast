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

/**
 * Render a message template for one contact.
 * Returns { text, missing } where missing lists placeholders that had no value.
 */
function render(template, contact) {
  const vars = buildVars(contact);
  const missing = [];
  const text = String(template === undefined || template === null ? '' : template)
    .replace(PLACEHOLDER_RE, (match, key, fallback) => {
      const nk = normKey(key);
      const canonical = ALIASES[nk] || nk;
      let value = vars[canonical];
      if (value === undefined) value = vars[nk];
      if (value === undefined || value === null || String(value).trim() === '') {
        if (fallback !== undefined) return fallback;
        missing.push(key.trim());
        return '';
      }
      return String(value);
    });
  return { text, missing };
}

/** List the distinct placeholder names used in a template, in order of appearance. */
function placeholders(template) {
  const found = [];
  const seen = new Set();
  let m;
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  while ((m = re.exec(String(template || ''))) !== null) {
    const key = m[1].trim();
    const nk = normKey(key);
    if (!seen.has(nk)) { seen.add(nk); found.push(key); }
  }
  return found;
}

/** Placeholders in a template that neither the built-in fields nor the extra columns can fill. */
function unknownPlaceholders(template, extraColumns = []) {
  const known = new Set([...BUILTIN_PLACEHOLDERS.map(normKey), ...Object.keys(ALIASES), ...extraColumns.map(normKey)]);
  return placeholders(template).filter(p => !known.has(normKey(p)));
}

module.exports = { render, placeholders, unknownPlaceholders, normKey, ALIASES, BUILTIN_PLACEHOLDERS };
