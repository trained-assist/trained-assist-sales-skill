'use strict';
// crm_deals_commands — карточка «команда бота → что вызвать».
//
// Три вещи, которые легко сломать:
//   1. палитра не выдаётся без объявленного токена CRM (иначе агент уверенно
//      выполнит вызовы, которые упадут);
//   2. имя CRM берётся из пути токена, а не из отдельной разметки;
//   3. карточка расходится с реальными сигнатурами тулов — поэтому проверяем,
//      что каждый упомянутый тул существует и принимает названные аргументы.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = require('../src/mcp-skills/tools/93-crm-deals-commands.js');
const WEEEK = require('../src/mcp-skills/tools/30-weeek.js');
const FLEXI = require('../src/mcp-skills/tools/92-flexi-sales.js');

function tmpTokens() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-notes-tokens-'));
  const prev = process.env.AGENT_TOKENS_DIR;
  process.env.AGENT_TOKENS_DIR = dir;
  return {
    dir,
    restore() {
      if (prev === undefined) delete process.env.AGENT_TOKENS_DIR;
      else process.env.AGENT_TOKENS_DIR = prev;
    },
  };
}

test('без токена CRM палитра не выдаётся, а не выдаётся вслепую', async () => {
  const t = tmpTokens();
  try {
    const r = await TOOL.tools.crm_deals_commands.handler({}, { userId: 'u1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CRM_PALETTE_UNAVAILABLE');
    assert.match(r.hint, /токен/i);
    assert.equal(r.card, undefined, 'карточки быть не должно');
  } finally { t.restore(); }
});

test('CRM определяется по объявленному токену', async () => {
  const t = tmpTokens();
  try {
    fs.mkdirSync(path.join(t.dir, 'u1'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'u1', 'weeek'), 'fake');
    const r = await TOOL.tools.crm_deals_commands.handler({ command: '/deals' }, { userId: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(r.crm, 'weeek');
    assert.ok(r.card.length > 500);
  } finally { t.restore(); }
});

test('явное имя CRM важнее найденного токена', async () => {
  const t = tmpTokens();
  try {
    fs.mkdirSync(path.join(t.dir, 'u1'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'u1', 'weeek'), 'fake');
    const r = await TOOL.tools.crm_deals_commands.handler({ crm: 'weeek' }, { userId: 'u1' });
    assert.equal(r.crm, 'weeek');
    assert.equal(r.ok, true);
  } finally { t.restore(); }
});

test('неизвестная CRM получает список известных, а не тишину', async () => {
  const t = tmpTokens();
  try {
    const r = await TOOL.tools.crm_deals_commands.handler({ crm: 'amocrm' }, { userId: 'u1' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.known_crms, ['weeek']);
    assert.match(r.hint, /amocrm/);
  } finally { t.restore(); }
});

test('карточка называет только существующие тулы с существующими аргументами', () => {
  const card = TOOL._test.CARD;
  const known = new Map([
    ...Object.entries(WEEEK.tools).map(([n, t]) => [n, Object.keys(t.inputSchema.properties || {})]),
    ...Object.entries(FLEXI.tools).map(([n, t]) => [n, Object.keys(t.inputSchema.properties || {})]),
  ]);

  // Ищем упоминания вида `tool_name(` — обратные кавычки в карточке.
  const mentioned = [...card.matchAll(/`([a-z][a-z0-9_]+)\(/g)].map(m => m[1]);
  assert.ok(mentioned.length > 10, 'карточка должна называть инструменты');

  const missing = [...new Set(mentioned)].filter(n => !known.has(n));
  assert.deepEqual(missing, [], `инструменты не найдены: ${missing.join(', ')}`);

  // Аргументы в карточке должны существовать в схеме тула.
  for (const [name, props] of known) {
    const re = new RegExp('`' + name + '\\(([^)]*)\\)', 'g');
    for (const m of card.matchAll(re)) {
      for (const arg of m[1].split(',')) {
        const key = arg.trim().replace(/[=?:].*$/, '').trim();
        if (!key) continue;
        assert.ok(props.includes(key), `${name}: аргумент «${key}» не в схеме`);
      }
    }
  }
});

test('карточка покрывает все команды бота из operator-help', () => {
  // Команды бота — из flexi-exhibition-deal-bot/src/operator-help.js.
  // Если бот добавит команду, а карточка о ней не скажет — агент её не выполнит.
  const botCommands = [
    'start', 'help', 'new', 'new_deal', 'new_partner', 'new_prelead',
    'preleads', 'deals', 'add_channel', 'add_status', 'cancel', 'chatid',
  ];
  const card = TOOL._test.CARD;
  const missing = botCommands.filter(c => !card.includes('/' + c));
  assert.deepEqual(missing, [], `команды без строки в карточке: ${missing.join(', ')}`);
});

test('карточка называет обязательные поля контракта G7', () => {
  const card = TOOL._test.CARD;
  for (const f of ['status_id', 'title', 'source', 'deal_type', 'company_inn', 'deal_comment', 'contact_name']) {
    assert.ok(card.includes(f), `в карточке нет обязательного поля ${f}`);
  }
});

test('привязка ролей видна в контексте: непривязанные роли названы', async () => {
  const t = tmpTokens();
  try {
    fs.mkdirSync(path.join(t.dir, 'u1'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'u1', 'weeek'), 'fake');
    fs.writeFileSync(path.join(t.dir, 'u1', 'weeek-refs.json'), JSON.stringify({ statuses: { Лид: 's1' } }));
    const r = await TOOL.tools.crm_deals_commands.handler({}, { userId: 'u1' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.context.refs_bound.statuses, ['Лид']);
    assert.equal(r.context.refs_unbound.statuses.length, 14);
    assert.match(r.context.hint, /weeek_set_refs/);
  } finally { t.restore(); }
});
