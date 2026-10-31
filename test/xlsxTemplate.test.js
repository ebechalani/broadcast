'use strict';
const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { buildTemplate, cleanVariableNames, BASE_HEADERS } = require('../src/xlsxTemplate');
const { parseContacts } = require('../src/contacts');
const { render } = require('../src/template');

test('cleanVariableNames fills defaults and validates the count', () => {
  assert.deepEqual(cleanVariableNames(0), []);
  assert.deepEqual(cleanVariableNames(3, ['School', '', '  Classe  ']), ['School', 'Variable 2', 'Classe']);
  assert.deepEqual(cleanVariableNames('2', ['{{Amount}}']), ['Amount', 'Variable 2']);
  assert.throws(() => cleanVariableNames(21), /between 0 and 20/);
  assert.throws(() => cleanVariableNames(-1), /between 0 and 20/);
  assert.throws(() => cleanVariableNames('abc'), /between 0 and 20/);
});

test('cleanVariableNames rejects names that clash with standard or each other', () => {
  for (const name of ['Phone', 'Mobile', 'Nom', 'Prénom', 'First Name', 'WhatsApp', 'Title']) {
    assert.throws(() => cleanVariableNames(1, [name]), /standard column/, name);
  }
  assert.throws(() => cleanVariableNames(2, ['School', 'school']), /used twice/);
  assert.throws(() => cleanVariableNames(1, ['---']), /letter or digit/);
});

test('the template has the standard columns, the variables, and an instructions sheet', () => {
  const wb = XLSX.read(buildTemplate(['School', 'Amount']), { cellNF: true });
  assert.deepEqual(wb.SheetNames, ['Contacts', 'Instructions']);
  const [headers] = XLSX.utils.sheet_to_json(wb.Sheets.Contacts, { header: 1 });
  assert.deepEqual(headers, [...BASE_HEADERS, 'School', 'Amount']);
  assert.equal(wb.Sheets.Contacts.E2.z, '@', 'number column is formatted as text');
});

test('a filled-in template imports with the right columns and placeholders', () => {
  const wb = XLSX.read(buildTemplate(['School', 'Amount due']));
  XLSX.utils.sheet_add_aoa(wb.Sheets.Contacts, [
    ['Mrs', 'Rita', 'Khoury', '961', '03 123 456', 'Lycée A', '120 $'],
    ['Mr', 'Pierre', 'Martin', '33', '6 00 00 00 02', 'Lycée B', '80 $'],
  ], { origin: 'A2' });
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const res = parseContacts({ buffer, filename: 'contacts-template.xlsx' }, { defaultCountry: 'LB' });
  assert.equal(res.stats.ok, 2, 'empty pre-formatted rows are ignored');
  assert.equal(res.mapping.phone, 'WhatsApp Number');
  assert.equal(res.mapping.countryCode, 'Country Code');
  assert.deepEqual(res.contacts.map(c => c.phone), ['9613123456', '33600000002']);
  const { text } = render('Bonjour {{Prefix}} {{lastName}}, {{School}}: {{Amount due}}', res.contacts[0]);
  assert.equal(text, 'Bonjour Mrs Khoury, Lycée A: 120 $');
});
