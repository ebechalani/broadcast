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

// Strip spaces, punctuation and quotes; turn the 00 international prefix into "+".
function clean(value) {
  let s = toRawString(value).trim();
  if (!s) return '';
  s = s.replace(/^[‘’'"`]+|[‘’'"`]+$/g, '');
  s = s.replace(/[\s().\-  ‐-―/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  return s;
}

const DIGITS = /^\+?\d{6,15}$/;
// Dates (2024-01-01, 12/03/2024) and decimals (1500.50) would look like phones once punctuation is stripped.
const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;
const DECIMAL_LIKE = /^\d+[.,]\d{1,2}$/;

function looksLikePhone(value) {
  const raw = toRawString(value).trim();
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

/**
 * Normalize any human-written phone number to the digits WhatsApp expects
 * (country code + number, no "+"), e.g. "70 123 456" with LB -> "96170123456".
 */
function normalizePhone(value, defaultCountry = 'LB') {
  const input = toRawString(value);
  const s = clean(value);
  if (!s) return { ok: false, reason: 'empty', input };
  if (!DIGITS.test(s)) return { ok: false, reason: 'not a phone number', input };

  // Numbers typed with the country code but without "+" (e.g. 96170123456)
  // are retried in international form.
  const candidates = s.startsWith('+') ? [s] : [s, '+' + s];
  let best = null;
  for (const candidate of candidates) {
    const pn = tryParse(candidate, defaultCountry);
    if (!pn) continue;
    if (pn.isValid()) { best = pn; break; }
    if (!best && pn.isPossible()) best = pn;
  }
  if (!best) return { ok: false, reason: `invalid number (default country ${defaultCountry})`, input };

  return {
    ok: true,
    e164: best.number,
    digits: best.number.slice(1),
    country: best.country || null,
    valid: best.isValid(),
    display: best.formatInternational(),
  };
}

module.exports = { normalizePhone, looksLikePhone, clean, toRawString };
