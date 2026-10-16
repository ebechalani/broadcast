'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { render, placeholders, unknownPlaceholders, normKey } = require('../src/template');

const contact = { firstName: 'Jean', lastName: 'Dupont', phoneDisplay: '+961 70 123 456', extra: { Classe: '6ème B', 'Montant dû': '150' } };

test('normKey strips accents, case and punctuation', () => {
  assert.equal(normKey('Prénom de l\'élève'), 'prenomdeleleve');
  assert.equal(normKey(' First_Name '), 'firstname');
  assert.equal(normKey(null), '');
});

test('render fills built-in placeholders in any spelling', () => {
  const { text, missing } = render('Bonjour {{firstName}} {{ LASTNAME }}, {{prénom}} / {{Nom}} / {{fullName}} / {{phone}}', contact);
  assert.equal(text, 'Bonjour Jean Dupont, Jean / Dupont / Jean Dupont / +961 70 123 456');
  assert.deepEqual(missing, []);
});

test('render fills extra columns and supports fallbacks', () => {
  const { text, missing } = render('Classe: {{classe}}, dû: {{Montant dû}}, {{inconnu|ami}}, {{autre}}.', contact);
  assert.equal(text, 'Classe: 6ème B, dû: 150, ami, .');
  assert.deepEqual(missing, ['autre']);
});

test('render leaves text without placeholders untouched and tolerates empty input', () => {
  assert.equal(render('Hello {world}', contact).text, 'Hello {world}');
  assert.equal(render(null, contact).text, '');
  assert.equal(render('{{firstName}}', {}).text, '');
});

test('placeholders lists distinct keys in order', () => {
  assert.deepEqual(placeholders('{{a}} {{ b | x }} {{A}} {{c}}'), ['a', 'b', 'c']);
});

test('unknownPlaceholders ignores built-ins, aliases and extra columns', () => {
  assert.deepEqual(unknownPlaceholders('{{firstName}} {{prenom}} {{Classe}} {{foo}}', ['Classe']), ['foo']);
});
