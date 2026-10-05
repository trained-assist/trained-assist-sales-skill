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
  for (const bad of ['', 'rosupack2026', 'deal_415', 'rosupack2026_deal',
                     'rosupack 2026_deal_1']) {
    assert.equal(TOOL._test.parseDeepLink(bad), null, bad);
  }
});

// Регрессия: company_id в реальных каталогах НЕ числовой. Проверено по всем
// пяти опубликованным каталогам (flexi-consulting/exhibitions): числовых id
// в них 0 из 1407, поэтому парсер «\d+» отвергал каждую ссылку, то есть
// кнопка «Создать сделку» не вела ни в одну сделку ни на одной выставке.
test('parseDeepLink принимает реальные id из каталогов, а не только цифры', () => {
  assert.deepEqual(TOOL._test.parseDeepLink('cpmautumn2026_deal_13C56'),
    { eventKey: 'cpmautumn2026', companyId: '13C56' });
  // IPSA: id участника — 24-символьный hex.
  assert.deepEqual(TOOL._test.parseDeepLink('ipsa2026_deal_6a34143181e2ea78990a38f9'),
    { eventKey: 'ipsa2026', companyId: '6a34143181e2ea78990a38f9' });
  // Генератор id для каталогов без исходных id: LNG001 / OL001.
  assert.deepEqual(TOOL._test.parseDeepLink('lingerie2026_deal_LNG001'),
    { eventKey: 'lingerie2026', companyId: 'LNG001' });
  assert.deepEqual(TOOL._test.parseDeepLink('otdykh2026_deal_OL001'),
    { eventKey: 'otdykh2026', companyId: 'OL001' });
  // Подчёркивание внутри id (cpm-autumn-2026/telegram_companies.json: 21_dot_12)
  // не должно съедать разделитель _deal_.
  assert.deepEqual(TOOL._test.parseDeepLink('cpmautumn2026_deal_21_dot_12'),
    { eventKey: 'cpmautumn2026', companyId: '21_dot_12' });
  // Следствие: «rosupack2026_deal_415_extra» больше не мусор, а id «415_extra» —
  // подчёркивание в id легально. Различить «id с подчёркиванием» и «хвост
  // после id» по строке нельзя, и выбирать первым нельзя: часть id реально
  // содержит '_'. companyId уходит только в query-параметр, eventKey (единственное,
  // что попадает в путь на диске) остаётся строгим — см. тест ниже.
  assert.deepEqual(TOOL._test.parseDeepLink('rosupack2026_deal_415_extra'),
    { eventKey: 'rosupack2026', companyId: '415_extra' });
});

test('parseDeepLink всё ещё не пускает мусор и не пускает путь в eventKey', () => {
  // eventKey идёт в путь на диске (expoDataDir) — обход каталога не проходит.
  for (const bad of [
    '.._deal_1', '../etc_deal_1', 'ro_su_pack2026_deal_1',
    'cpmautumn2026_deal_', 'cpmautumn2026_deal_../../etc', 'cpmautumn2026_deal_a b',
    'cpmautumn2026_deal_a/b', 'cpmautumn2026_deal_a?b', 'cpmautumn2026_deal_a#b',
  ]) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Handler целиком. До этих правок он был невызываемым: строка 556 звала
// sessionUser(ctx), которой нет ни в импортах, ни в файле — ReferenceError до
// любой валидации. А валидация всё равно была бы тупиком: contact_name в схеме
// не было, а контракт G7 его требует, поэтому повторный вызов ничего не мог
// исправить.
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function stubProfile(t, { refs } = {}) {
  const tokens = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-tokens-'));
  const dir = path.join(tokens, 'u1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weeek'), 'test-token');
  fs.writeFileSync(path.join(dir, 'weeek-refs.json'), JSON.stringify(refs || { statuses: { Лид: 'status-lead' } }));
  const prev = process.env.AGENT_TOKENS_DIR;
  process.env.AGENT_TOKENS_DIR = tokens;
  t.after(() => {
    if (prev === undefined) delete process.env.AGENT_TOKENS_DIR;
    else process.env.AGENT_TOKENS_DIR = prev;
  });
  return tokens;
}

const NOTES_OK = {
  ok: true,
  notes: [{ text: 'просил КП', transcript: '', createdAt: '2026-10-04T12:00:00.000Z' }],
  status: { rejected: false },
  hasDeal: false,
};

async function withFetch(t, route, fn) {
  const prev = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return route(String(url), opts, calls.length);
  };
  t.after(() => { global.fetch = prev; });
  const out = await fn(calls);
  return { out, calls };
}

test('handler доходит до контракта полей, а не падает на sessionUser', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out } = await withFetch(t, url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : jsonResponse({}, 500),
    () => TOOL.tools.flexi_deal_from_catalog.handler({ payload: 'rosupack2026_deal_415', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEAL_MISSING_REQUIRED_FIELDS');
  assert.deepEqual(out.missing, ['contact_name']);
  // Точное следующее действие: иначе агент повторяет тот же вызов вечно.
  assert.equal(out.next_call.payload, 'rosupack2026_deal_415');
  assert.ok('contact_name' in out.next_call);
  assert.equal(out.company_name, 'Эксимпак-Ротопринт ТД');
  assert.equal(out.notes_attached, 1);
});

test('контакт, названный агентом, завершает путь до сделки в Weeek', async t => {
  stubProfile(t, { refs: { statuses: { Лид: 'status-lead' }, deal_fields: { deal_comment: 'cf-comment' } } });
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : jsonResponse({ deal: { id: 'deal-77' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.deal.id, 'deal-77');

  const post = calls.find(c => c.url.includes('api.weeek.net'));
  assert.ok(post, 'сделка должна создаваться в Weeek');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.title, 'Эксимпак-Ротопринт ТД');
  assert.equal(post.opts.method, 'POST');
  // Заметка посетителя и данные компании обязаны дойти до сделки.
  assert.match(body.description, /просил КП/);
  assert.match(body.description, /ИНН: 7701234567/);
  assert.match(body.description, /Выручка: 820 млн руб\./);
  // Контакт агента — в поле по привязке роли, а не потерялся.
  assert.equal(body.customFields['cf-comment'] !== undefined, true);
});

test('ИНН, которого нет в данных выставки, агент дописывает сам', async t => {
  stubProfile(t, { refs: { statuses: { Лид: 'status-lead' }, deal_fields: { inn: 'cf-inn' } } });
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ...NOTES_OK, notes: [] }) : jsonResponse({ deal: { id: 'deal-78' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_416', contact_name: 'Пётр Сидоров', company_inn: '9909887766', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, true, JSON.stringify(out));
  const post = calls.find(c => c.url.includes('api.weeek.net'));
  const body = JSON.parse(post.opts.body);
  // ИНН обязан реально попасть в сделку: роль в профиле называется inn, а
  // контракт обязательных полей — company_inn. Раньше значение терялось между
  // ними, и обязательное поле не доезжало до Weeek.
  assert.equal(body.customFields['cf-inn'], '9909887766');
});

test('ошибка Weeek не выдаётся за «сделка создана» и повтор остаётся безопасным', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : jsonResponse({ error: 'deal is invalid' }, 400),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEAL_CREATE_FAILED');
  assert.equal(out.deal_created, false, 'Weeek отказал — сделки нет, повторять можно');
  assert.match(out.error, /Weeek API 400/);
});

test('неясный ответ Weeek не превращается в повторное создание', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : (() => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    })(),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEAL_CREATE_OUTCOME_UNKNOWN');
  // «Не знаю» — это не «не создана»: повтор вслепую даст дубликат.
  assert.equal(out.deal_created, 'unknown');
  assert.match(out.hint, /weeek_list_deals/);
});

test('буквенный id из каталога находит свою компанию, а не первую подряд', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();
  // Тот же стенд у обеих компаний, но id разные — как в CPM (13C56 / 13C57).
  const dir = path.join(workDir, 'expo-pipeline', 'cpmautumn2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'enriched.json'), JSON.stringify([
    { id: '13C56', n: '3W GREAT', s: '13C56', hall: 'Зал 13', inn: '7743421876' },
    { id: '13C57', n: 'ДРУГАЯ КОМПАНИЯ', s: '13C56', hall: 'Зал 13', inn: '7709887766' },
  ]));

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ...NOTES_OK, notes: [] }) : jsonResponse({ deal: { id: 'deal-99' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'cpmautumn2026_deal_13C57', contact_name: 'ЛПР', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.company_name, 'ДРУГАЯ КОМПАНИЯ');
  const post = calls.find(c => c.url.includes('api.weeek.net'));
  assert.equal(JSON.parse(post.opts.body).title, 'ДРУГАЯ КОМПАНИЯ');
});

test('уже созданная сделка не создаётся второй раз', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ...NOTES_OK, hasDeal: true }) : jsonResponse({ deal: { id: 'x' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, false);
  assert.equal(out.has_deal, true);
  assert.equal(calls.filter(c => c.url.includes('api.weeek.net')).length, 0);
});

test('отказ на карточке блокирует создание сделки', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes')
      ? jsonResponse({ ok: true, notes: [], status: { rejected: true, rejectionReason: 'отказ' }, hasDeal: false })
      : jsonResponse({ deal: { id: 'x' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'u1' }, { workDir }));

  assert.equal(out.ok, false);
  assert.equal(out.rejected, true);
  assert.equal(calls.filter(c => c.url.includes('api.weeek.net')).length, 0);
});
