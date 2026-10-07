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
    () => TOOL.tools.flexi_deal_from_catalog.handler({ payload: 'rosupack2026_deal_415' }, { workDir, userId: 'u1' }));

  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEAL_MISSING_REQUIRED_FIELDS');
  assert.deepEqual(out.missing, ['contact_name']);
  // Точное следующее действие: иначе агент повторяет тот же вызов вечно.
  assert.equal(out.next_call.payload, 'rosupack2026_deal_415');
  assert.ok('contact_name' in out.next_call);
  assert.equal(out.company_name, 'Эксимпак-Ротопринт ТД');
  assert.equal(out.notes_attached, 1);
});

test('profile identity comes from trusted context; a tool argument cannot select another profile', async t => {
  const tokens = stubProfile(t);
  const attacker = path.join(tokens, 'attacker');
  fs.mkdirSync(attacker, { recursive: true });
  fs.writeFileSync(path.join(attacker, 'weeek'), 'attacker-token');
  fs.writeFileSync(path.join(attacker, 'weeek-refs.json'), JSON.stringify({ statuses: { Лид: 'attacker-status' } }));
  const workDir = tmpWorkDir();
  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : jsonResponse({ deal: { id: 'deal-trusted' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров', user_id: 'attacker' },
      { workDir, userId: 'u1' }));

  assert.equal(TOOL.tools.flexi_deal_from_catalog.inputSchema.properties.user_id, undefined);
  assert.equal(out.ok, true, JSON.stringify(out));
  const create = calls.find(c => c.url.includes('api.weeek.net'));
  assert.match(create.url, /status-lead/);
  assert.doesNotMatch(create.url, /attacker-status/);
});

test('simultaneous deal requests claim one binding before either calls Weeek', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();
  let noteReads = 0;
  let releaseReads;
  const bothReadNotes = new Promise(resolve => { releaseReads = resolve; });
  const results = await withFetch(t, async (url, opts) => {
    if (url.includes('site-predeal-notes') && opts.method !== 'POST') {
      noteReads++;
      if (noteReads === 2) releaseReads();
      await bothReadNotes;
      return jsonResponse(NOTES_OK);
    }
    if (url.includes('site-predeal-notes')) return jsonResponse({ ok: true, markedAt: '2026-10-06T00:00:00.000Z' });
    return jsonResponse({ deal: { id: 'deal-once' } });
  }, async () => Promise.all([
    TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }),
    TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }),
  ]));

  const creates = results.calls.filter(c => c.url.includes('api.weeek.net'));
  assert.equal(creates.length, 1, 'only one concurrent invocation may dispatch deal creation');
  assert.equal(results.out.filter(out => out.ok).length, 1);
  assert.equal(results.out.filter(out => out.code === 'DEAL_CREATE_IN_PROGRESS' || out.existing_deal).length, 1);
  const binding = JSON.parse(fs.readFileSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json'), 'utf8'));
  assert.equal(binding.state, 'created');
  assert.equal(binding.deal_id, 'deal-once');
  assert.equal(fs.statSync(BINDING_DIR(workDir)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json')).mode & 0o777, 0o600);
});

test('контакт, названный агентом, завершает путь до сделки в Weeek', async t => {
  stubProfile(t, { refs: { statuses: { Лид: 'status-lead' }, deal_fields: { deal_comment: 'cf-comment' } } });
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse(NOTES_OK) : jsonResponse({ deal: { id: 'deal-77' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

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
      { payload: 'rosupack2026_deal_416', contact_name: 'Пётр Сидоров', company_inn: '9909887766' }, { workDir, userId: 'u1' }));

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
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

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
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

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
      { payload: 'cpmautumn2026_deal_13C57', contact_name: 'ЛПР' }, { workDir, userId: 'u1' }));

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
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

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
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

  assert.equal(out.ok, false);
  assert.equal(out.rejected, true);
  assert.equal(calls.filter(c => c.url.includes('api.weeek.net')).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Привязка карточка → сделка и запись статуса на сайт (C4).
// ─────────────────────────────────────────────────────────────────────────────

const BINDING_DIR = (workDir) => path.join(workDir, 'expo-pipeline', 'rosupack2026', 'deals');

test('созданная сделка записывается в привязку и статус уходит на сайт', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes')
      ? jsonResponse({ ok: true, notes: [], status: { rejected: false }, hasDeal: false })
      : jsonResponse({ deal: { id: 'deal-100' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.deal_id, 'deal-100');
  assert.equal(out.site_status, 'synced');

  const binding = JSON.parse(fs.readFileSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json'), 'utf8'));
  assert.equal(binding.state, 'created');
  assert.equal(binding.deal_id, 'deal-100');
  assert.equal(binding.company_name, 'Эксимпак-Ротопринт ТД');

  const mark = calls.find(c => c.opts?.body instanceof FormData && String(c.url).includes('site-predeal-notes'));
  assert.ok(mark, 'статус сделки должен уходить в API заметок');
  assert.equal(mark.opts.body.get('statusAction'), 'deal');
  assert.equal(mark.opts.body.get('dealId'), 'deal-100');
});

test('повторный вызов возвращает ту же сделку и не создаёт вторую', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const first = await withFetch(t,
    url => url.includes('site-predeal-notes')
      ? jsonResponse({ ok: true, notes: [], status: { rejected: false }, hasDeal: false })
      : jsonResponse({ deal: { id: 'deal-100' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));
  assert.equal(first.out.ok, true);

  const second = await withFetch(t,
    url => url.includes('site-predeal-notes')
      ? jsonResponse({ ok: true, notes: [], status: { rejected: false }, hasDeal: true })
      : jsonResponse({ deal: { id: 'deal-SECOND' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

  assert.equal(second.out.ok, true);
  assert.equal(second.out.existing_deal, true);
  assert.equal(second.out.deal_id, 'deal-100', 'сделка обязана остаться той же');
  assert.equal(second.calls.filter(c => c.url.includes('api.weeek.net')).length, 0, 'повторный вызов не ходит в Weeek');
});

test('незакрытая операция не даёт создать вторую сделку', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  // Состояние «создаётся» оставляет упавший процесс или потерянный ответ.
  fs.mkdirSync(BINDING_DIR(workDir), { recursive: true });
  fs.writeFileSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json'), JSON.stringify({
    event_key: 'rosupack2026', company_id: '415', company_name: 'Эксимпак-Ротопринт ТД',
    state: 'creating', op_id: 'op-x', started_at: new Date().toISOString(),
  }));

  const { out, calls } = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ok: true, notes: [] }) : jsonResponse({ deal: { id: 'x' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

  assert.equal(out.ok, false);
  assert.equal(out.code, 'DEAL_CREATE_IN_PROGRESS');
  assert.equal(calls.filter(c => c.url.includes('api.weeek.net')).length, 0);
});

test('сбой записи статуса не отменяет сделку и повторяется отдельно', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  // Отметка сделки — POST; чтение заметок — GET. Отдаём 503 только на POST.
  const { out } = await withFetch(t,
    (url, opts) => {
      if (!String(url).includes('site-predeal-notes')) return jsonResponse({ deal: { id: 'deal-100' } });
      if (opts?.method === 'POST') return jsonResponse({ ok: false, error: '503 Service Unavailable' }, 503);
      return jsonResponse({ ok: true, notes: [], status: { rejected: false }, hasDeal: false });
    },
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));

  // Сделка создана — это главное. Статус не записан — это отдельная проблема.
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.deal_id, 'deal-100');
  assert.equal(out.site_status, 'sync_failed');
  assert.equal(out.next_tool, 'flexi_sync_deal_status');

  // Восстановление: статус дописывается, сделка не создаётся заново.
  const sync = await withFetch(t,
    url => url.includes('site-predeal-notes')
      ? jsonResponse({ ok: true, alreadyMarked: false, markedAt: new Date().toISOString() })
      : jsonResponse({ deal: { id: 'deal-SHOULD-NOT-HAPPEN' } }),
    () => TOOL.tools.flexi_sync_deal_status.handler({ event_key: 'rosupack2026' }, { workDir, userId: 'u1' }));

  assert.equal(sync.out.ok, true, JSON.stringify(sync.out));
  assert.equal(sync.out.synced, 1);
  assert.equal(sync.calls.filter(c => c.url.includes('api.weeek.net')).length, 0, 'синхронизация не создаёт сделок');

  const binding = JSON.parse(fs.readFileSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json'), 'utf8'));
  assert.equal(binding.state, 'created');
  assert.ok(binding.site_marked_at, 'отметка о записи статуса должна сохраниться');
});

test('синхронизация без привязки не создаёт сделку и не падает', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();
  const { out } = await withFetch(t,
    url => jsonResponse({ ok: true, notes: [] }),
    () => TOOL.tools.flexi_sync_deal_status.handler({ event_key: 'rosupack2026' }, { workDir, userId: 'u1' }));
  assert.equal(out.ok, true);
  assert.equal(out.synced, 0);
  assert.match(out.message, /нечего/);
});

test('явный отказ Weeek снимает операцию и позволяет повторить', async t => {
  stubProfile(t);
  const workDir = tmpWorkDir();

  const first = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ok: true, notes: [] }) : jsonResponse({ error: 'bad' }, 400),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));
  assert.equal(first.out.ok, false);
  assert.equal(first.out.code, 'DEAL_CREATE_FAILED');
  assert.equal(fs.existsSync(path.join(BINDING_DIR(workDir), 'rosupack2026__415.json')), false,
    'операция снята — повтор разрешён');

  const second = await withFetch(t,
    url => url.includes('site-predeal-notes') ? jsonResponse({ ok: true, notes: [] }) : jsonResponse({ deal: { id: 'deal-OK' } }),
    () => TOOL.tools.flexi_deal_from_catalog.handler(
      { payload: 'rosupack2026_deal_415', contact_name: 'Иван Петров' }, { workDir, userId: 'u1' }));
  assert.equal(second.out.ok, true, JSON.stringify(second.out));
  assert.equal(second.out.deal_id, 'deal-OK');
});
