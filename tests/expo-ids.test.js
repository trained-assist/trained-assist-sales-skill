'use strict';
// Контракт идентичности компании: один на каталог, deep-link и поиск сделки.
//
// Тесты на данных, которые действительно лежат в каталогах
// (flexi-consulting/exhibitions, CPM Осень 2026), а не на выдуманных:
// 13С11 — кириллическая «С», 13C18/13D19 — компания на двух стендах,
// «____________» — стенд не разобран. Ни один из них нельзя передать
// в Telegram-ссылке, поэтому парсер обязан их отвергать, а сборщик — падать.

const test = require('node:test');
const assert = require('node:assert');

const {
  parseDeepLink,
  isLinkSafeId,
  isTelegramStartParameterSafe,
  findIdProblems,
} = require('../src/mcp-skills/expo-ids.js');

test('годные id из реальных каталогов разбираются', () => {
  const good = [
    ['cpmautumn2026_deal_13C56', 'cpmautumn2026', '13C56'],
    ['cpmautumn2026_deal_21_dot_12', 'cpmautumn2026', '21_dot_12'],
    ['lingerie2026_deal_LNG001', 'lingerie2026', 'LNG001'],
    ['otdykh2026_deal_OL001', 'otdykh2026', 'OL001'],
    ['ipsa2026_deal_6a34143181e2ea78990a38f9', 'ipsa2026', '6a34143181e2ea78990a38f9'],
    ['rosupack2026_deal_415', 'rosupack2026', '415'],
  ];
  for (const [payload, eventKey, companyId] of good) {
    assert.deepEqual(parseDeepLink(payload), { eventKey, companyId }, payload);
    assert.equal(isLinkSafeId(companyId), true, companyId);
  }
});

test('id из реального каталога, который Telegram не передаст, не проходит', () => {
  // На глаз 13С11 неотличима от 13C11 — это ловушка, а не опечатка.
  const cyrillic = '13С11';
  assert.equal(cyrillic.length, 5);
  assert.equal(isLinkSafeId(cyrillic), false);
  assert.equal(parseDeepLink('cpmautumn2026_deal_' + cyrillic), null);

  // Компания на нескольких стендах: id склеен из стенда.
  for (const id of ['13C18/13D19', '13A19, 13A11', '14 B80', '15A42 / 15A46', '____________', 'company.id']) {
    assert.equal(isLinkSafeId(id), false, id);
    assert.equal(parseDeepLink('cpmautumn2026_deal_' + id), null, id);
  }
});

test('eventKey остаётся строгим: он идёт в путь на диске', () => {
  for (const bad of [
    '.._deal_1', '../etc_deal_1', 'ro_su_pack2026_deal_1',
    'cpmautumn2026_deal_', 'cpmautumn2026_deal_../../etc',
  ]) {
    assert.equal(parseDeepLink(bad), null, bad);
  }
});

test('Telegram start-параметр соблюдает алфавит и предел 64 символа', () => {
  assert.equal(isTelegramStartParameterSafe('A-z_09'), true);
  assert.equal(isTelegramStartParameterSafe('company.id'), false);
  assert.equal(isTelegramStartParameterSafe('a'.repeat(64)), true);
  assert.equal(isTelegramStartParameterSafe('a'.repeat(65)), false);
  assert.equal(parseDeepLink('rosupack2026_deal_company.id'), null);
  assert.equal(parseDeepLink('a'.repeat(58) + '_deal_x'), null);
  assert.deepEqual(parseDeepLink('a'.repeat(57) + '_deal_x'), {
    eventKey: 'a'.repeat(57), companyId: 'x',
  });
});

test('findIdProblems находит повтор id между компаниями одного стенда', () => {
  const companies = [
    { id: '13C56', n: '3W GREAT', stand: '13C56' },
    { id: '13C56', n: 'СОСЕДНИЙ УЧАСТНИК', stand: '13C56' },
    { id: '15A59', n: 'ACCESSORIES-111', stand: '15A59' },
  ];
  const { duplicates, unsafe } = findIdProblems(companies);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].id, '13C56');
  assert.equal(duplicates[0].first, '3W GREAT');
  assert.equal(duplicates[0].second, 'СОСЕДНИЙ УЧАСТНИК');
  assert.equal(unsafe.length, 0);
});

test('findIdProblems считает компанию один раз и помечает непригодные id', () => {
  const companies = [
    { id: '13C56', n: 'A' },
    { id: '13С11', n: 'B' },       // кириллическая С
    { id: '____________', n: 'C' }, // стенд не разобран
    { id: '13C18/13D19', n: 'D' }, // два стенда
  ];
  const { duplicates, unsafe } = findIdProblems(companies);
  assert.equal(duplicates.length, 0);
  assert.deepEqual(unsafe.map(u => u.id), ['13С11', '____________', '13C18/13D19']);
});

test('findIdProblems не падает на пустом и битом входе', () => {
  for (const input of [[], null, undefined, [{}, { id: '' }]]) {
    const r = findIdProblems(input);
    assert.ok(r && Array.isArray(r.duplicates) && Array.isArray(r.unsafe));
  }
});

test('findIdProblems checks the complete Telegram parameter, not just the company id', () => {
  const exact = findIdProblems([{ id: 'x', n: 'A' }], 'a'.repeat(57));
  assert.equal(exact.payloadTooLong.length, 0);

  const tooLong = findIdProblems([{ id: 'x', n: 'A' }], 'a'.repeat(58));
  assert.equal(tooLong.payloadTooLong.length, 1);
  assert.equal(tooLong.payloadTooLong[0].length, 65);

  const invalidEventKey = findIdProblems([{ id: 'x', n: 'A' }], 'event.key');
  assert.equal(invalidEventKey.invalidEventKey, true);
});
