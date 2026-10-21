'use strict';
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

function toRawString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // Excel stores phone numbers typed without quotes as numbers.
    return String(Math.round(value));
  }
  return String(value);
}

/** Map Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
function asciiDigits(s) {
  return s
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
}

// Strip invisible marks, spaces, punctuation and quotes; turn the 00 prefix into "+".
function clean(value) {
  let s = toRawString(value);
  // Bidi/zero-width marks come along when numbers are copied from a phone or WhatsApp.
  s = s.replace(/\p{Cf}/gu, '').trim();
  if (!s) return '';
  s = asciiDigits(s);
  s = s.replace(/^[‘’'"`]+|[‘’'"`]+$/g, '');
  s = s.replace(/[\s().\-  ‐-―/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

const DIGITS = /^\+?\d{6,15}$/;
// Dates (2024-01-01, 12/03/2024) and decimals (1500.50) would look like phones once punctuation is stripped.
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;
const DECIMAL_LIKE = /^\d+[.,]\d{1,2}$/;
// "70 123 456 / 71 234 567", "70123456, 71234567", "70 123 456 ou 71 234 567"
const MULTI_SPLIT = /\s*(?:\/|,|;|\|| ou | or | et | and |\n)\s*/i;

function looksLikePhone(value) {
  const raw = toRawString(value).replace(/\p{Cf}/gu, '').trim();
  if (DATE_LIKE.test(raw) || DECIMAL_LIKE.test(raw)) return false;
  return DIGITS.test(clean(value));
}

function tryParse(s, defaultCountry) {
  try {
    return parsePhoneNumberFromString(s, defaultCountry) || null;
  } catch {
    return null;
  }
}

function parseOne(s, defaultCountry) {
  // Numbers typed with the country code but without "+" (e.g. 96170123456)
  // are retried in international form.
  const candidates = s.startsWith('+') ? [s] : [s, '+' + s];
  let best = null;
  for (const candidate of candidates) {
    const pn = tryParse(candidate, defaultCountry);
    if (!pn) continue;
    if (pn.isValid()) { best = pn; break; }
    // A merely "possible" number is only kept when read as written: the "+" retry must be valid,
    // otherwise a foreign local number (612345678) would pass as an Australian one.
    if (!best && pn.isPossible() && candidate === s) best = pn;
  }
  return best;
}

function describe(pn, input, note) {
  return {
    ok: true,
    e164: pn.number,
    digits: pn.number.slice(1),
    country: pn.country || null,
    valid: pn.isValid(),
    display: pn.formatInternational(),
    input,
    note: note || null,
  };
}

/**
 * Normalize any human-written phone number to the digits WhatsApp expects
 * (country code + number, no "+"), e.g. "70 123 456" with LB -> "96170123456".
 */
function normalizePhone(value, defaultCountry = 'LB') {
  const input = toRawString(value);
  const trimmed = input.replace(/\p{Cf}/gu, '').trim();
  if (DATE_LIKE.test(trimmed) || DECIMAL_LIKE.test(trimmed)) return { ok: false, reason: 'looks like a date or an amount', input };
  const s = clean(value);
  if (!s) return { ok: false, reason: 'empty', input };

  if (!DIGITS.test(s)) {
    // Several numbers in one cell: use the first one that parses.
    const parts = trimmed.split(MULTI_SPLIT).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        const ps = clean(part);
        if (!DIGITS.test(ps)) continue;
        const pn = parseOne(ps, defaultCountry);
        if (pn) return describe(pn, input, 'cell held several numbers, the first valid one was used');
      }
    }
    return { ok: false, reason: 'not a phone number', input };
  }

  const best = parseOne(s, defaultCountry);
  if (!best) return { ok: false, reason: `invalid number (default country ${defaultCountry})`, input };
  return describe(best, input);
}

module.exports = { normalizePhone, looksLikePhone, clean, toRawString };
