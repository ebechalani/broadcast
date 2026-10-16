'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseContacts, splitFullName } = require('../src/contacts');

test('CSV with English headers and comma delimiter', () => {
  const text = 'First name,Last name,WhatsApp\nJean,Dupont,+961 70 123 456\nMarie,Curie,03 123 456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.hasHeader, true);
  assert.deepEqual(r.mapping, { phone: 'WhatsApp', phonePrefix: null, firstName: 'First name', lastName: 'Last name', fullName: null, phoneFallbacks: [] });
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

test('title and blank rows above the real header are skipped and row numbers stay true', () => {
  const text = 'Liste des élèves 2025-2026\n\nNom;Prénom;Classe;Tel\nDUPONT;Jean;6ème B;70123456\n\nCURIE;Marie;5ème A;71234567\nX;Y;4ème;70123456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.headerRow, 3);
  assert.equal(r.mapping.lastName, 'Nom');
  assert.equal(r.mapping.firstName, 'Prénom');
  assert.equal(r.mapping.phone, 'Tel');
  assert.equal(r.contacts.length, 3);
  assert.equal(r.contacts[0].firstName, 'Jean');
  assert.equal(r.contacts[0].row, 4);
  assert.equal(r.contacts[1].row, 6);
  assert.equal(r.contacts[2].status, 'duplicate');
  assert.match(r.contacts[2].reason, /row 4/);
});

test('phone column named like a phone but holding other data is not used', () => {
  const r1 = parseContacts({ text: 'Numéro;Nom;Prénom;Tél\n1;DUPONT;Jean;70123456\n2;CURIE;Marie;71234567\n' }, { defaultCountry: 'LB' });
  assert.equal(r1.mapping.phone, 'Tél');
  assert.equal(r1.stats.ok, 2);
  const r2 = parseContacts({ text: 'Nom;Prénom;WhatsApp;Téléphone\nDUPONT;Jean;oui;70123456\n' }, { defaultCountry: 'LB' });
  assert.equal(r2.mapping.phone, 'Téléphone');
  const r3 = parseContacts({ text: 'Nom;Prénom;Atelier;Numéro WhatsApp Parent\nDUPONT;Jean;Théâtre;70123456\n' }, { defaultCountry: 'LB' });
  assert.equal(r3.mapping.phone, 'Numéro WhatsApp Parent');
});

test('combined "Nom et Prénom" column is split, "Nom de l\'élève" pairs with "Prénom de l\'élève"', () => {
  const r1 = parseContacts({ text: 'Nom et Prénom;Numéro\nDUPONT Jean;70123456\nABOU KHALIL Marie Rose;71234567\n' }, { defaultCountry: 'LB' });
  assert.equal(r1.mapping.fullName, 'Nom et Prénom');
  assert.equal(r1.contacts[0].firstName, 'Jean');
  assert.equal(r1.contacts[0].lastName, 'Dupont');
  assert.equal(r1.contacts[1].firstName, 'Marie Rose');
  assert.equal(r1.contacts[1].lastName, 'Abou Khalil');
  const r2 = parseContacts({ text: "Nom de l'élève;Prénom de l'élève;Situation familiale;Tel parent\nDUPONT;Jean;Mariés;70123456\n" }, { defaultCountry: 'LB' });
  assert.equal(r2.mapping.lastName, "Nom de l'élève");
  assert.equal(r2.mapping.firstName, "Prénom de l'élève");
  assert.equal(r2.contacts[0].lastName, 'Dupont');
  assert.equal(r2.contacts[0].extra['Situation familiale'], 'Mariés');
});

test('second phone column is used when the first is empty', () => {
  const text = 'Nom;Prénom;Mobile Père;Mobile Mère\nDUPONT;Jean;70123456;71234567\nCURIE;Marie;;76123456\nHASSAN;Ali;;\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.phone, 'Mobile Père');
  assert.deepEqual(r.mapping.phoneFallbacks, ['Mobile Mère']);
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[0].phoneSource, null);
  assert.equal(r.contacts[1].phone, '96176123456');
  assert.equal(r.contacts[1].phoneSource, 'Mobile Mère');
  assert.match(r.contacts[1].reason, /Mobile Mère/);
  assert.equal(r.contacts[2].status, 'invalid');
  assert.equal(r.contacts[2].reason, 'empty');
});

test('stale mapping names (after a header toggle) keep the detection instead of wiping it', () => {
  const text = 'Nom;Prénom;Tel\nDUPONT;Jean;70123456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB', hasHeader: false, mapping: { firstName: 'Prénom', lastName: 'Nom', phone: 'Tel', fullName: null } });
  assert.equal(r.hasHeader, false);
  assert.equal(r.mapping.phone, 'Column 3');
  assert.equal(r.contacts.length, 2);
});

test('Excel date cells are rendered as dd/mm/yyyy', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Prénom', 'Nom', 'Tel', 'Date de naissance'],
    ['Jean', 'Dupont', 70123456, new Date(2010, 4, 14)],
  ], { cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contacts');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const r = parseContacts({ buffer, filename: 'liste.xlsx' }, { defaultCountry: 'LB' });
  assert.equal(r.contacts[0].extra['Date de naissance'], '14/05/2010');
  assert.equal(r.contacts[0].phone, '96170123456');
});

test('teachers layout: Name, Whatsapp, Prefix (country code), Last Name, School', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School\nRita,70 123 456,961,Khoury,Lycée A\nPierre,6 12 34 56 78,+33,Martin,Lycée B\nSami,0096171234567,961,Haddad,Lycée A\nNour,96176123456,961,Saad,Lycée C\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.firstName, 'Name');
  assert.equal(r.mapping.lastName, 'Last Name');
  assert.equal(r.mapping.phone, 'Whatsapp');
  assert.equal(r.mapping.phonePrefix, 'Prefix');
  assert.deepEqual(r.extraHeaders, ['School']);
  assert.deepEqual(r.contacts.map(c => c.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '33612345678', 'prefix +33 applied to a French local number');
  assert.equal(r.contacts[2].phone, '96171234567', 'number already international: prefix ignored');
  assert.equal(r.contacts[3].phone, '96176123456', 'number with country code but no plus: still correct');
  assert.equal(r.contacts[0].firstName, 'Rita');
  assert.equal(r.contacts[0].lastName, 'Khoury');
  assert.equal(r.contacts[0].extra.School, 'Lycée A');
});

test('a "Prefix" column holding titles stays an ordinary placeholder column', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School\nRita,70 123 456,Mrs,Khoury,Lycée A\nPierre,+33 6 12 34 56 78,Mr,Martin,Lycée B\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.phonePrefix, null);
  assert.deepEqual(r.extraHeaders, ['Prefix', 'School']);
  assert.equal(r.contacts[0].extra.Prefix, 'Mrs');
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '33612345678');
});

test('truncated "Whatsap" header is still recognised as the phone column', () => {
  const r = parseContacts({ text: 'Name,Whatsap,Last Name\nRita,70123456,Khoury\n' }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.phone, 'Whatsap');
  assert.equal(r.contacts[0].phone, '96170123456');
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
