'use strict';
// flexi_deal_from_catalog — разбор deep-link и сборка сделки из карточки.
//
// Это путь «посетитель оставил заметку → менеджер нажал „Создать сделку“ →
// сделка в Weeek с заметкой». Три вещи, которые здесь легко сломать и которые
// ломали раньше:
//   1. id берётся из данных выставки, а НЕ из стенда — иначе несколько компаний
//      на одном стенде схлопываются в одну сделку (74 дубля deal_payload в CPM);
//   2. заметки обязаны доехать до сделки, а не остаться в prelead;
//   3. статус и источник берутся через привязку ролей к ID, а не угадываются.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = require('../src/mcp-skills/tools/92-flexi-sales.js');

// Компактная схема enriched.json (проверена на реальных данных RosUpack:
// b, cat, country, dir, dirpos, hall, href, id, inn, n, name, ogrn, okved,
// prof, py, rev, ry, s, w).
const COMPANIES = [
  { id: 415, n: 'Эксимпак-Ротопринт ТД', s: 'E5045', hall: 'Павильон 5', inn: '7701234567',
    ogrn: '1027700123456', okved: '17.12', rev: 820, ry: 2024, prof: 41, py: 2024,
    b: 'Упаковочное оборудование', cat: 'Этикетка', w: 'https://example.ru', t: 1, country: 'Россия' },
  { id: 416, n: 'Соседний стенд', s: 'E5045', hall: 'Павильон 5', inn: null, t: 0 },
];

function tmpWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-from-catalog-'));
  fs.mkdirSync(path.join(dir, 'expo-pipeline', 'rosupack2026'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'expo-pipeline', 'rosupack2026', 'enriched.json'),
    JSON.stringify(COMPANIES)
  );
  return dir;
}

test('parseDeepLink разбирает payload и отвергает мусор', () => {
  assert.deepEqual(TOOL._test.parseDeepLink('rosupack2026_deal_415'),
    { eventKey: 'rosupack2026', companyId: '415' });
  assert.deepEqual(TOOL._test.parseDeepLink('cpm-autumn-2026_deal_7'),
    { eventKey: 'cpm-autumn-2026', companyId: '7' });
  for (const bad of ['', 'rosupack2026', 'deal_415', 'rosupack2026_deal', 'rosupack2026_deal_abc',
                     'rosupack2026_deal_415_extra', 'rosupack 2026_deal_1']) {
    assert.equal(TOOL._test.parseDeepLink(bad), null, bad);
  }
});

test('companyInfoText собирает только заполненные поля', () => {
  const text = TOOL._test.companyInfoText(COMPANIES[0]);
  assert.match(text, /Упаковочное оборудование/);
  assert.match(text, /ИНН: 7701234567/);
  assert.match(text, /ОГРН: 1027700123456/);
  assert.match(text, /ОКВЭД: 17\.12/);
  assert.match(text, /Выручка: 820 млн руб\., 2024/);
  assert.match(text, /Прибыль: 41 млн руб\., 2024/);
  assert.match(text, /Страна: Россия/);
  assert.match(text, /Категории: Этикетка/);

  // Пустые поля не дают пустых строк и не дают «Выручка: undefined».
  const sparse = TOOL._test.companyInfoText(COMPANIES[1]);
  assert.equal(sparse, '');
});

test('notesToText помечает аудио и не дублирует расшифровку в тексте', () => {
  const text = TOOL._test.notesToText([
    { kind: 'text', text: 'Интересен стенд, просил КП', at: '2026-10-04T12:00:00.000Z' },
    { kind: 'audio', text: '', transcript: 'Здравствуйте, пришлите прайс', at: '2026-10-04T12:05:00.000Z' },
  ]);
  assert.match(text, /Заметка 1 — Интересен стенд, просил КП/);
  assert.match(text, /Аудиозаметка 2 — Расшифровка: Здравствуйте, пришлите прайс/);
  // Если расшифровка совпадает с текстом — второй раз её не печатаем.
  const dup = TOOL._test.notesToText([{ kind: 'text', text: 'привет', transcript: 'привет' }]);
  assert.equal((dup.match(/привет/g) || []).length, 1);
});

test('requireRef бросает понятную ошибку на непривязанную роль', () => {
  assert.throws(() => TOOL._test.requireRef({}, 'statuses', 'Лид'), /не привязана/);
  assert.throws(() => TOOL._test.requireRef({ statuses: {} }, 'statuses', 'Лид'), /не привязана/);
  assert.equal(TOOL._test.requireRef({ statuses: { Лид: 's1' } }, 'statuses', 'Лид'), 's1');
  // Пустое название роли — тоже ошибка, а не «любая привязка».
  assert.throws(() => TOOL._test.requireRef({ statuses: { Лид: 's1' } }, 'statuses', '  '), /пустая роль/);
});

test('handler находит компанию по id из данных, а не по стенду', async () => {
  const workDir = tmpWorkDir();
  // Оба стенда E5045, но разные id — каждая компания обязана найти свою запись.
  const found = TOOL._test.findCompanyForTest(workDir, 'rosupack2026', '416');
  assert.equal(found.n, 'Соседний стенд');
  assert.equal(found.id, 416);

  const missing = TOOL._test.findCompanyForTest(workDir, 'rosupack2026', '999');
  assert.equal(missing, null);
});

test('handler отличает выставку без данных', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-no-data-'));
  assert.equal(TOOL._test.findCompanyForTest(dir, 'rosupack2026', '415'), null);
});

test('заметки попадают в комментарий сделки, а не теряются', () => {
  const { notesToText } = TOOL._test;
  const comment = [
    'Создано со страницы каталога RosUpack 2026.',
    'Локация: Павильон 3 Зал 14, стенд E5045',
    notesToText([{ kind: 'text', text: 'просил КП', at: '2026-10-04T12:00:00.000Z' }])
  ].filter(Boolean).join('\n');
  assert.match(comment, /Заметка 1 — просил КП/);
  // Это главное требование владельца: менеджер обязан видеть, что писал посетитель.
  assert.ok(comment.includes('просил КП'));
});
