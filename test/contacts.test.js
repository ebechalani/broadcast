'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseContacts, splitFullName } = require('../src/contacts');

test('CSV with English headers and comma delimiter', () => {
  const text = 'First name,Last name,WhatsApp\nJean,Dupont,+961 70 123 456\nMarie,Curie,03 123 456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.hasHeader, true);
  assert.deepEqual(r.mapping, { phone: 'WhatsApp', firstName: 'First name', lastName: 'Last name', fullName: null });
  assert.equal(r.contacts.length, 2);
  assert.equal(r.contacts[0].firstName, 'Jean');
  assert.equal(r.contacts[0].lastName, 'Dupont');
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '9613123456');
  assert.equal(r.stats.ok, 2);
});

test('CSV with French headers, semicolons, BOM and extra columns', () => {
  const text = '﻿Nom;Prénom;Téléphone;Classe\nDUPONT;Jean;70 123 456;6ème B\nCURIE;Marie;71 234 567;5ème A\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.firstName, 'Prénom');
  assert.equal(r.mapping.lastName, 'Nom');
  assert.equal(r.mapping.phone, 'Téléphone');
  assert.deepEqual(r.extraHeaders, ['Classe']);
  assert.equal(r.contacts[0].lastName, 'Dupont'); // shouting names are title-cased
  assert.equal(r.contacts[0].extra.Classe, '6ème B');
  assert.equal(r.contacts[1].phone, '96171234567');
});

test('headerless rows and tab-separated paste', () => {
  const text = 'Jean\tDupont\t+961 70 123 456\nMarie\tCurie\t+961 71 234 567';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.hasHeader, false);
  assert.equal(r.contacts.length, 2);
  assert.equal(r.contacts[0].firstName, 'Jean');
  assert.equal(r.contacts[0].lastName, 'Dupont');
  assert.equal(r.contacts[0].phone, '96170123456');
});

test('single full-name column is split', () => {
  const text = 'Nom,Tel\nDUPONT Jean,70123456\nMarie Curie,71234567\nMadonna,76123456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.fullName, 'Nom');
  assert.equal(r.contacts[0].firstName, 'Jean');
  assert.equal(r.contacts[0].lastName, 'Dupont');
  assert.equal(r.contacts[1].firstName, 'Marie');
  assert.equal(r.contacts[1].lastName, 'Curie');
  assert.equal(r.contacts[2].firstName, 'Madonna');
  assert.equal(r.contacts[2].lastName, '');
});

test('invalid and duplicate numbers are flagged, not dropped', () => {
  const text = 'first,last,phone\nA,B,70123456\nC,D,abc\nE,F,+96170123456\nG,H,\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.deepEqual(r.contacts.map(c => c.status), ['ok', 'invalid', 'duplicate', 'invalid']);
  assert.equal(r.stats.ok, 1);
  assert.equal(r.stats.invalid, 2);
  assert.equal(r.stats.duplicate, 1);
  assert.match(r.contacts[2].reason, /row 2/);
});

test('manual mapping override wins over detection', () => {
  const text = 'a,b,c\nDupont,Jean,70123456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB', mapping: { firstName: 'b', lastName: 'a', phone: 'c' } });
  assert.equal(r.contacts[0].firstName, 'Jean');
  assert.equal(r.contacts[0].lastName, 'Dupont');
});

test('xlsx workbook with numeric phone cells', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Prénom', 'Nom', 'Numéro WhatsApp'],
    ['Jean', 'Dupont', 96170123456],
    ['Marie', 'Curie', '71 234 567'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = parseContacts({ buffer, filename: 'liste.xlsx' }, { defaultCountry: 'LB' });
  assert.equal(r.contacts.length, 2);
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '96171234567');
  assert.equal(r.mapping.phone, 'Numéro WhatsApp');
});

test('Windows-1252 and UTF-16 CSV exports are decoded correctly', () => {
  const ansi = Buffer.from('Pr\xe9nom;Nom;T\xe9l\xe9phone\nJ\xe9r\xf4me;Dupont;70123456\n', 'latin1');
  const r1 = parseContacts({ buffer: ansi, filename: 'liste.csv' }, { defaultCountry: 'LB' });
  assert.equal(r1.mapping.firstName, 'Prénom');
  assert.equal(r1.contacts[0].firstName, 'Jérôme');
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Prénom\tNom\tTel\nJérôme\tDupont\t70123456\n', 'utf16le')]);
  const r2 = parseContacts({ buffer: utf16, filename: 'liste.txt' }, { defaultCountry: 'LB' });
  assert.equal(r2.contacts[0].firstName, 'Jérôme');
  assert.equal(r2.contacts[0].phone, '96170123456');
});

test('empty input', () => {
  const r = parseContacts({ text: '' });
  assert.equal(r.contacts.length, 0);
  assert.equal(r.stats.total, 0);
});

test('splitFullName heuristics', () => {
  assert.deepEqual(splitFullName('DUPONT Jean'), { firstName: 'Jean', lastName: 'DUPONT' });
  assert.deepEqual(splitFullName('Jean DUPONT'), { firstName: 'Jean', lastName: 'DUPONT' });
  assert.deepEqual(splitFullName('Jean Pierre Dupont'), { firstName: 'Jean', lastName: 'Pierre Dupont' });
  assert.deepEqual(splitFullName('ABOU KHALIL Marie'), { firstName: 'Marie', lastName: 'ABOU KHALIL' });
  assert.deepEqual(splitFullName(''), { firstName: '', lastName: '' });
});
