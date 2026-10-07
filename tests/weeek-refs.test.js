'use strict';
// weeek_set_refs / weeek_get_refs — привязка ролей к ID Weeek.
//
// Зачем: ID опций у каждого Weeek-workspace свои, а в коде скилла живёт только
// схема. Без привязки агент не может ни создать сделку в нужной воронке, ни
// поставить источник — и не должен угадывать ID.
//
// Сетевой слой подменяется глобальным fetch: токен читается из профиля, а
// weeekFetch ходит через него. Ни одного реального запроса.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Профиль агента — временный, а не ~/agent-tokens: иначе тесты читают и пишут
// настоящие токены. До require, потому что модуль читает env при загрузке.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weeek-refs-home-'));
process.env.AGENT_TOKENS_DIR = path.join(HOME, 'agent-tokens');

const TOOL = require('../src/mcp-skills/tools/30-weeek.js');

const FUNNEL_ROLES = ['Сколково', 'Партнеры'];
const DEAL_TYPE_ROLES = ['direct', 'partner'];

let seq = 0;
// Каждый тест получает свой uid: иначе токен, написанный одним тестом, виден
// всем остальным, и тест «требует токен» начинает ходить в сеть.
function freshUser() {
  seq += 1;
  return `u${process.pid}-${seq}`;
}

function writeToken(uid) {
  const dir = path.join(process.env.AGENT_TOKENS_DIR, uid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weeek'), 'fixture-token', { mode: 0o600 });
  return uid;
}

const refsFile = uid => path.join(process.env.AGENT_TOKENS_DIR, uid, 'weeek-refs.json');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  };
}

/** Глобальный fetch с заданными воронками и статусами. Возвращает восстановитель. */
function stubFetch({ funnels, statuses }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/crm/funnels')) return jsonResponse({ funnels });
    const m = u.match(/\/crm\/funnels\/([^/]+)\/statuses$/);
    if (m) return jsonResponse({ statuses: statuses[decodeURIComponent(m[1])] ?? [] });
    throw new Error(`unexpected fetch: ${u}`);
  };
  return () => { globalThis.fetch = original; };
}

test('weeek_set_refs привязывает воронки и статусы по названию', async () => {
  const uid = writeToken(freshUser());
  const restore = stubFetch({
    funnels: [
      { id: 'f-scol', name: 'Сколково' },
      { id: 'f-part', name: 'Партнеры' },
      { id: 'f-other', name: 'Другая' },
    ],
    statuses: {
      'f-scol': [{ id: 's-lead', name: 'Лид' }, { id: 's-won', name: 'Выиграно' }],
      'f-part': [{ id: 's-lead', name: 'Лид' }, { id: 's-lost', name: 'Проиграно' }],
    },
  });

  const out = await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  restore();

  assert.equal(out.ok, true, out.error);
  assert.equal(out.refs.funnels['Сколково'], 'f-scol');
  assert.equal(out.refs.funnels['Партнеры'], 'f-part');
  assert.ok(out.refs.statuses['Лид']);
  assert.equal(out.refs.statuses['Выиграно'], 's-won');
  assert.equal(out.refs.statuses['Проиграно'], 's-lost');

  // Файл реально лежит в профиле и читается обратно.
  const file = refsFile(uid);
  assert.ok(fs.existsSync(file), 'weeek-refs.json не создан');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).funnels['Сколково'], 'f-scol');
});

test('weeek_set_refs не падает на пустом ответе — честно отчитывается', async () => {
  const uid = writeToken(freshUser());
  const restore = stubFetch({ funnels: [], statuses: {} });

  const out = await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  restore();

  // В Weeek может не быть воронки с таким названием — это не ошибка, а данные.
  assert.equal(out.ok, true);
  assert.deepEqual(out.matched.funnels, []);
  const unmatched = out.matched.unmatched.map(x => x.role);
  for (const role of FUNNEL_ROLES) assert.ok(unmatched.includes(role), `в unmatched нет ${role}`);
});

test('weeek_set_refs требует токен', async () => {
  const uid = freshUser(); // токен намеренно не пишем
  const out = await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  assert.equal(out.ok, undefined);
  assert.match(out.error, /token not set/);
});

test('weeek_get_refs показывает непривязанные роли из схемы', async () => {
  const uid = writeToken(freshUser());
  const restore = stubFetch({
    funnels: [{ id: 'f-scol', name: 'Сколково' }],
    statuses: { 'f-scol': [{ id: 's-lead', name: 'Лид' }] },
  });
  await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  restore();

  const out = await TOOL.tools.weeek_get_refs.handler({ user_id: uid });
  assert.equal(out.ok, true);
  assert.deepEqual(out.unbound.funnels, ['Партнеры']);
  assert.ok(out.unbound.statuses.includes('Выиграно'));
  assert.ok(out.unbound.deal_sources.includes('RosUpack 2026'));
  assert.deepEqual(out.unbound.deal_types, DEAL_TYPE_ROLES);
  assert.equal(out.deal_type_labels.direct, 'Прямые продажи');
});

test('weeek_set_refs не затирает привязку, созданную вручную', async () => {
  const uid = writeToken(freshUser());
  const dir = path.join(process.env.AGENT_TOKENS_DIR, uid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weeek-refs.json'), JSON.stringify({
    deal_sources: { 'RosUpack 2026': 'manual-id-1' },
    deal_types: { direct: 'manual-id-2' },
  }), { mode: 0o600 });

  const restore = stubFetch({ funnels: [], statuses: {} });
  const out = await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  restore();

  assert.equal(out.refs.deal_sources['RosUpack 2026'], 'manual-id-1');
  assert.equal(out.refs.deal_types.direct, 'manual-id-2');
});

test('схема источников и типов объявлена целиком', async () => {
  const uid = writeToken(freshUser());
  const restore = stubFetch({ funnels: [], statuses: {} });
  const out = await TOOL.tools.weeek_set_refs.handler({ user_id: uid });
  restore();

  // 21 источник + 2 типа обязаны быть в схеме — иначе они молча исчезнут.
  const unbound = out.matched.unmatched.map(x => x.role);
  assert.ok(unbound.length >= 23, `ожидалось >= 23 непривязанных, получено ${unbound.length}`);
  assert.ok(unbound.includes('RosUpack 2026'));
  assert.ok(unbound.includes('ECOM Expo 2026'));
});
