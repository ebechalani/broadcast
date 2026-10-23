'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { render, placeholders, unknownPlaceholders, normKey, countVariations } = require('../src/template');

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
  assert.equal(text, 'Classe: 6ème B, dû: 150, ami,.'); // the space before an empty value is dropped
  assert.deepEqual(missing, ['autre']);
});

test('render leaves text without placeholders untouched and tolerates empty input', () => {
  assert.equal(render('Hello {world}', contact).text, 'Hello {world}');
  assert.equal(render(null, contact).text, '');
  assert.equal(render('{{firstName}}', {}).text, '');
});

test('title column: {{Prefix}} and its synonyms, with tidy spacing when empty', () => {
  const mrs = { firstName: 'Rita', lastName: 'Khoury', extra: { Prefix: 'Mrs', School: 'Lycée A' } };
  const none = { firstName: 'Nour', lastName: 'Saad', extra: { Prefix: '', School: 'Lycée C' } };
  assert.equal(render('Dear {{Prefix}} {{lastName}},', mrs).text, 'Dear Mrs Khoury,');
  assert.equal(render('Dear {{title}} {{lastName}},', mrs).text, 'Dear Mrs Khoury,');
  assert.equal(render('Dear {{civilité}} {{lastName}},', mrs).text, 'Dear Mrs Khoury,');
  assert.equal(render('Dear {{Prefix}} {{lastName}},', none).text, 'Dear Saad,');
  assert.equal(render('{{Prefix}} {{lastName}}, bonjour', none).text, 'Saad, bonjour');
  assert.equal(render('Hello {{Prefix}},\nSee you', none).text, 'Hello,\nSee you');
  assert.equal(render('Dear {{Prefix}} {{firstName}} {{lastName}}', { extra: { Prefix: '' }, firstName: '', lastName: 'Saad' }).text, 'Dear Saad');
  assert.equal(render('Dear {{Prefix|colleague}} {{lastName}}', none).text, 'Dear colleague Saad');
  assert.deepEqual(render('Dear {{Prefix}} {{lastName}}', none).missing, ['Prefix']);
  assert.deepEqual(unknownPlaceholders('{{title}} {{Prefix}}', ['Prefix', 'School']), []);
});

test('empty values next to WhatsApp formatting, quotes, Arabic punctuation and French spaces', () => {
  const c = { lastName: 'Saad', extra: { Prefix: '' } };
  assert.equal(render('Dear *{{Prefix}} {{lastName}}*,', c).text, 'Dear *Saad*,');
  assert.equal(render('_{{Prefix}} {{lastName}}_', c).text, '_Saad_');
  assert.equal(render('Hello ({{Prefix}} {{lastName}})', c).text, 'Hello (Saad)');
  assert.equal(render('*Bonjour {{Prefix}}*', c).text, '*Bonjour*');
  assert.equal(render('«Bonjour {{Prefix}}»', c).text, '«Bonjour»');
  assert.equal(render('Bonjour {{Prefix}}…', c).text, 'Bonjour…');
  assert.equal(render('مرحبا {{Prefix}}، كيف حالك', c).text, 'مرحبا، كيف حالك');
  assert.equal(render('Bonjour {{Prefix}} !', c).text, 'Bonjour !');
  assert.equal(render('Dear {{Prefix}} {{School}},', { lastName: 'Saad', extra: { Prefix: '', School: '' } }).text, 'Dear,');
});

test('empty values keep the author\'s indentation and remove lines that would be blank', () => {
  const c = { lastName: 'Saad', extra: { Prefix: '', School: '' } };
  assert.equal(render('Dear,\n  {{Prefix}} {{lastName}}', c).text, 'Dear,\n  Saad');
  assert.equal(render('Nom:\t{{Prefix}} {{lastName}}', c).text, 'Nom:\tSaad');
  assert.equal(render('Bonjour,\n{{School}}\nMerci', c).text, 'Bonjour,\nMerci');
  assert.equal(render('Bonjour,\r\n{{School}}\r\nMerci', c).text, 'Bonjour,\r\nMerci');
});

test('invisible-only values count as empty, missing has no duplicates, leftovers are flagged', () => {
  const c = { lastName: 'Saad', extra: { Prefix: '​' } };
  const r = render('Dear {{Prefix}} {{lastName}}. {{Prefix}} {{prefix}}', c);
  assert.equal(r.text, 'Dear Saad.');
  assert.deepEqual(r.missing, ['Prefix']);
  assert.equal(render('Dear {{Prefix}} {{lastName}}', { lastName: 'Saad', extra: { Prefix: '\u0000' } }).text, 'Dear Saad');
  assert.equal(render('Dear {{Prefix|{{lastName}}}}', { lastName: 'Saad', extra: { Prefix: '' } }).leftover, true);
  assert.equal(render('Dear {{lastName}}', { lastName: 'Saad' }).leftover, false);
});

test('title synonyms prefer an honorific column and skip blank ones', () => {
  assert.equal(render('Dear {{civilité}} {{lastName}}', { lastName: 'Saad', extra: { Prefix: '', Title: 'Mrs' } }).text, 'Dear Mrs Saad');
  assert.equal(render('Dear {{title}} {{lastName}}', { lastName: 'Saad', extra: { Prefix: 'Mrs' } }).text, 'Dear Mrs Saad');
});

test('a placeholder with a fallback is not reported as unknown', () => {
  assert.deepEqual(unknownPlaceholders('Dear {{Prefix|colleague}} {{lastName}}', ['School']), []);
  assert.deepEqual(unknownPlaceholders('Dear {{Prefix|colleague}} {{Prefix}}', ['School']), ['Prefix']);
});

function people(n) {
  return Array.from({ length: n }, (_, i) => ({ firstName: `P${i}`, lastName: `L${i}`, phone: String(96170000000 + i), extra: { Prefix: i % 3 ? 'Mrs' : '', School: 'Lycée A' } }));
}

test('variations: each person gets one option, always the same one, and all options get used', () => {
  const t = '{Bonjour|Bonsoir|Cher collègue} {{lastName}}';
  const seen = new Set();
  for (const c of people(60)) {
    const a = render(t, c).text;
    assert.equal(render(t, c).text, a, 'stable for the same person');
    assert.match(a, /^(Bonjour|Bonsoir|Cher collègue) L\d+$/);
    seen.add(a.split(' L')[0]);
  }
  assert.deepEqual([...seen].sort(), ['Bonjour', 'Bonsoir', 'Cher collègue']);
});

test('variations: nesting, placeholders inside options, fallbacks and literal braces', () => {
  const c = { firstName: 'Rita', lastName: 'Khoury', phone: '96170000001', extra: { Prefix: '' } };
  const nested = new Set(people(80).map(p => render('{A|{B|C}}', p).text));
  assert.deepEqual([...nested].sort(), ['A', 'B', 'C']);
  assert.match(render('{Bonjour {{firstName}}|Salut {{lastName}}}!', c).text, /^(Bonjour Rita|Salut Khoury)!$/);
  assert.equal(render('Dear {{Prefix|colleague}}', c).text, 'Dear colleague', 'a placeholder fallback is not a variation');
  assert.equal(render('Hello {world}', c).text, 'Hello {world}', 'braces without | stay as written');
  const unfinished = render('Oops {Bonjour|Salut', c);
  assert.equal(unfinished.text, 'Oops {Bonjour|Salut');
  assert.equal(unfinished.leftover, true);
});

test('variations: spacing around | and optional text', () => {
  const texts = t => new Set(people(60).map(p => render(t, { ...p, lastName: 'Saad' }).text));
  assert.deepEqual([...texts('{Bonjour | Salut} {{lastName}},')].sort(), ['Bonjour Saad,', 'Salut Saad,']);
  assert.deepEqual([...texts('17h.{| Merci de confirmer.}')].sort(), ['17h.', '17h. Merci de confirmer.']);
  assert.deepEqual([...texts('17h. {|Merci de confirmer.}')].sort(), ['17h.', '17h. Merci de confirmer.']);
  assert.deepEqual([...texts('Bonjour {cher collègue|} {{lastName}},')].sort(), ['Bonjour Saad,', 'Bonjour cher collègue Saad,']);
});

test('countVariations multiplies independent choices and adds nested ones', () => {
  assert.equal(countVariations('no choice here'), 1);
  assert.equal(countVariations('{a|b} {c|d|e}'), 6);
  assert.equal(countVariations('{a|{b|c}}'), 3);
  assert.equal(countVariations('{{Prefix|colleague}} {x|y}'), 2);
  assert.equal(countVariations('{world}'), 1);
});

test('text spacing is untouched when every placeholder has a value', () => {
  const c = { firstName: 'A', lastName: 'B', extra: {} };
  assert.equal(render('Line  with   spaces {{firstName}}  {{lastName}}\n\n  indented', c).text, 'Line  with   spaces A  B\n\n  indented');
});

test('placeholders lists distinct keys in order', () => {
  assert.deepEqual(placeholders('{{a}} {{ b | x }} {{A}} {{c}}'), ['a', 'b', 'c']);
});

test('unknownPlaceholders ignores built-ins, aliases and extra columns', () => {
  assert.deepEqual(unknownPlaceholders('{{firstName}} {{prenom}} {{Classe}} {{foo}}', ['Classe']), ['foo']);
});
