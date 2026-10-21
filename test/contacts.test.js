'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseContacts, splitFullName } = require('../src/contacts');

test('CSV with English headers and comma delimiter', () => {
  const text = 'First name,Last name,WhatsApp\nJean,Dupont,+961 70 123 456\nMarie,Curie,03 123 456\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.hasHeader, true);
  assert.deepEqual(r.mapping, { phone: 'WhatsApp', countryCode: null, firstName: 'First name', lastName: 'Last name', fullName: null, phoneFallbacks: [] });
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

test('teachers layout: Name, Whatsapp, Prefix (title), Last Name, School, Country Code', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School,Country Code\n'
    + 'Rita,70 123 456,Mrs,Khoury,Lycée A,961\n'
    + 'Pierre,6 12 34 56 78,Mr,Martin,Lycée B,+33\n'
    + 'Sami,0096171234567,Mr,Haddad,Lycée A,961\n'
    + 'Nour,76 123 456,,Saad,Lycée C,\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.firstName, 'Name');
  assert.equal(r.mapping.lastName, 'Last Name');
  assert.equal(r.mapping.phone, 'Whatsapp');
  assert.equal(r.mapping.countryCode, 'Country Code');
  assert.deepEqual(r.extraHeaders, ['Prefix', 'School']);
  assert.deepEqual(r.contacts.map(c => c.status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '33612345678', 'country code +33 applied to a French local number');
  assert.equal(r.contacts[2].phone, '96171234567', 'number already international: country code ignored');
  assert.equal(r.contacts[3].phone, '96176123456', 'empty country code: default country used');
  assert.equal(r.contacts[0].firstName, 'Rita');
  assert.equal(r.contacts[0].lastName, 'Khoury');
  assert.equal(r.contacts[0].extra.Prefix, 'Mrs');
  assert.equal(r.contacts[0].extra.School, 'Lycée A');
});

test('"Prefix" is never treated as a country code, even when it holds digits', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School\nRita,70 123 456,Mrs,Khoury,Lycée A\nPierre,+33 6 12 34 56 78,Mr,Martin,Lycée B\nAli,71 234 567,1,Hassan,Lycée C\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.countryCode, null);
  assert.deepEqual(r.extraHeaders, ['Prefix', 'School']);
  assert.equal(r.contacts[0].extra.Prefix, 'Mrs');
  assert.equal(r.contacts[0].phone, '96170123456');
  assert.equal(r.contacts[1].phone, '33612345678');
  assert.equal(r.contacts[2].phone, '96171234567');
});

test('a number already written with its own code is not given the code twice', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School,Country Code\n'
    + 'Amal,971501234567,Mrs,Ali,A,971\n'
    + 'Hans,4915123456789,Mr,Meyer,B,49\n'
    + 'Joost,31612345678,Mr,Jansen,C,31\n'
    + 'Rita,96170123456,Mrs,Khoury,D,961\n'
    + 'Pierre,06 12 34 56 78,Mr,Martin,E,33\n'
    + "Paul,'0612345678,Mr,Durand,F,33\n";
  const r = parseContacts({ text }, { defaultCountry: 'LB' });
  assert.deepEqual(r.contacts.map(c => c.phone), ['971501234567', '4915123456789', '31612345678', '96170123456', '33612345678', '33612345678']);
  assert.equal(r.contacts[5].status, 'duplicate', 'same number as Pierre once the apostrophe is ignored');
});

test('country codes written in other ways, and generic "Country" / "Code" headers', () => {
  const r1 = parseContacts({ text: 'Name,Whatsapp,Last Name,Country Code\nPierre,06 12 34 56 78,Martin,+33 (France)\nRita,70 123 456,Khoury,961 (Liban)\nJean,06 11 22 33 44,Dupont,33.0\n' }, { defaultCountry: 'LB' });
  assert.equal(r1.mapping.countryCode, 'Country Code');
  assert.deepEqual(r1.contacts.map(c => c.phone), ['33612345678', '96170123456', '33611223344']);
  const r2 = parseContacts({ text: 'Name,Whatsapp,Last Name,Country\nPierre,06 12 34 56 78,Martin,33\nRita,70 123 456,Khoury,961\n' }, { defaultCountry: 'LB' });
  assert.equal(r2.mapping.countryCode, 'Country');
  assert.equal(r2.contacts[0].phone, '33612345678');
  const r3 = parseContacts({ text: 'Name,Whatsapp,Last Name,Country Code\nPierre,06 12 34 56 78,Martin,+33\nRita,70 123 456,Khoury,LB\nSami,71 234 567,Haddad,Liban\n' }, { defaultCountry: 'LB' });
  assert.equal(r3.mapping.countryCode, 'Country Code', 'a clearly named column is used even if only some cells hold a code');
  assert.deepEqual(r3.contacts.map(c => c.phone), ['33612345678', '96170123456', '96171234567']);
  const r4 = parseContacts({ text: 'Name,Whatsapp,Last Name,Code\nRita,70 123 456,Khoury,9999\nSami,71 234 567,Haddad,7777\n' }, { defaultCountry: 'LB' });
  assert.equal(r4.mapping.countryCode, null, 'codes that are not real calling codes are ignored');
});

test('the Prefix column cannot be chosen as the country code, even by hand', () => {
  const text = 'Name,Whatsapp,Prefix,Last Name,School,Country Code\nPierre,06 12 34 56 78,Mr,Martin,S,33\n';
  const r = parseContacts({ text }, { defaultCountry: 'LB', mapping: { countryCode: 'Prefix' } });
  assert.equal(r.mapping.countryCode, 'Country Code');
  assert.equal(r.contacts[0].phone, '33612345678');
  assert.equal(r.contacts[0].extra.Prefix, 'Mr');
});

test('pasted teacher rows without a header: the Mr/Mrs column is not taken as the last name', () => {
  const r = parseContacts({ text: 'Rita,70 123 456,Mrs,Khoury,Lycée A\nSami,71 234 567,Mr,Haddad,Lycée B\n' }, { defaultCountry: 'LB' });
  assert.equal(r.hasHeader, false);
  assert.equal(r.contacts[0].firstName, 'Rita');
  assert.equal(r.contacts[0].lastName, 'Khoury');
  assert.equal(r.contacts[1].lastName, 'Haddad');
});

test('a foreign local number without its code is invalid, not read as another country', () => {
  const r = parseContacts({ text: 'Name,Whatsapp,Prefix,Last Name\nPierre,612345678,33,Martin\n' }, { defaultCountry: 'LB' });
  assert.equal(r.contacts[0].status, 'invalid');
});

test('a "Country Code" column holding country names is not used as a dialing code', () => {
  const r = parseContacts({ text: 'Name,Whatsapp,Last Name,Country Code\nRita,70 123 456,Khoury,Lebanon\n' }, { defaultCountry: 'LB' });
  assert.equal(r.mapping.countryCode, null);
  assert.equal(r.contacts[0].phone, '96170123456');
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
