'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, looksLikePhone } = require('../src/phone');

test('Lebanese numbers in local and international formats', () => {
  for (const raw of ['70 123 456', '70123456', '+961 70 123 456', '0096170123456', '96170123456', '(70) 123-456', '+961-70-123456']) {
    const r = normalizePhone(raw, 'LB');
    assert.equal(r.ok, true, `${raw} should parse`);
    assert.equal(r.digits, '96170123456', `${raw} -> ${r.digits}`);
    assert.equal(r.e164, '+96170123456');
    assert.equal(r.country, 'LB');
  }
});

test('Lebanese 03 numbers with trunk zero', () => {
  const r = normalizePhone('03 123 456', 'LB');
  assert.equal(r.ok, true);
  assert.equal(r.digits, '9613123456');
});

test('foreign numbers keep their own country code regardless of default', () => {
  assert.equal(normalizePhone('+33 6 12 34 56 78', 'LB').digits, '33612345678');
  assert.equal(normalizePhone('0033612345678', 'LB').digits, '33612345678');
  assert.equal(normalizePhone('06 12 34 56 78', 'FR').digits, '33612345678');
  assert.equal(normalizePhone('+1 (415) 555-2671', 'LB').digits, '14155552671');
});

test('numbers coming from Excel as numeric cells', () => {
  assert.equal(normalizePhone(96170123456, 'LB').digits, '96170123456');
  assert.equal(normalizePhone(70123456, 'LB').digits, '96170123456');
});

test('garbage is rejected with a reason', () => {
  assert.equal(normalizePhone('', 'LB').ok, false);
  assert.equal(normalizePhone('   ', 'LB').reason, 'empty');
  assert.equal(normalizePhone('hello', 'LB').ok, false);
  assert.equal(normalizePhone('123', 'LB').ok, false);
  assert.equal(normalizePhone('+961 1', 'LB').ok, false);
  assert.equal(normalizePhone(null, 'LB').ok, false);
});

test('invisible marks, Arabic digits and several numbers in one cell', () => {
  assert.equal(normalizePhone('‎+961 70 123 456', 'LB').digits, '96170123456');
  assert.equal(normalizePhone('‪+961 70 123 456‬', 'LB').digits, '96170123456');
  assert.equal(normalizePhone('70​123​456', 'LB').digits, '96170123456');
  assert.equal(normalizePhone('٧٠١٢٣٤٥٦', 'LB').digits, '96170123456');
  const multi = normalizePhone('70 123 456 / 71 234 567', 'LB');
  assert.equal(multi.digits, '96170123456');
  assert.match(multi.note, /several numbers/);
  assert.equal(normalizePhone('14/05/2010', 'LB').ok, false);
  assert.equal(normalizePhone('2024-01-01', 'LB').reason, 'looks like a date or an amount');
});

test('looksLikePhone', () => {
  assert.equal(looksLikePhone('+961 70 123 456'), true);
  assert.equal(looksLikePhone('70123456'), true);
  assert.equal(looksLikePhone('Jean'), false);
  assert.equal(looksLikePhone('2024-01-01'), false);
  assert.equal(looksLikePhone(''), false);
});
