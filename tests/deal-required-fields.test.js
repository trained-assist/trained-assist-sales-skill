'use strict';
// Контракт обязательных полей сделки (sales-skill#19, G7).
//
// Визард гарантировал заполнение полей конечным автоматом. Агент — нет: он может
// позвать create_deal с половиной полей, и получится сделка, в которой менеджер
// не видит ни заметки посетителя, ни ИНН. Контракт обязан быть явным.

const test = require('node:test');
const assert = require('node:assert');

const { validateDealInput, DEAL_REQUIRED_FIELDS, DEAL_TYPES } =
  require('../src/mcp-skills/tools/30-weeek.js');

const FULL = {
  status_id: 's1', title: 'ООО Ромашка', source: 'RosUpack 2026',
  deal_type: 'direct', company_inn: '7701234567',
  deal_comment: 'Заметка с сайта', contact_name: 'Иван',
};

test('полный набор полей проходит', () => {
  assert.deepEqual(validateDealInput(FULL), { ok: true });
});

test('каждое обязательное поле проверяется по отдельности', () => {
  for (const field of DEAL_REQUIRED_FIELDS) {
    const input = { ...FULL };
    delete input[field.key];
    const res = validateDealInput(input);
    assert.equal(res.ok, false, `${field.key} должен быть обязательным`);
    assert.equal(res.code, 'DEAL_MISSING_REQUIRED_FIELDS');
    assert.deepEqual(res.missing, [field.key]);
    assert.match(res.error, new RegExp(field.label.split(' ')[0]), `в ошибке нет названия «${field.label}»`);
  }
});

test('пустые и пробельные значения считаются незаполненными', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const res = validateDealInput({ ...FULL, company_inn: bad });
    assert.equal(res.ok, false, `значение ${JSON.stringify(bad)} должно быть отклонено`);
    assert.ok(res.missing.includes('company_inn'));
  }
});

test('тип сделки обязан быть из схемы', () => {
  // Пустой тип — это «не заполнено», а не «неверный»: сначала проверка наличия.
  assert.equal(validateDealInput({ ...FULL, deal_type: '' }).code, 'DEAL_MISSING_REQUIRED_FIELDS');
  for (const bad of ['conference', 'partnerx', 42, 'directx']) {
    const res = validateDealInput({ ...FULL, deal_type: bad });
    assert.equal(res.ok, false, `тип ${JSON.stringify(bad)} должен быть отклонён`);
    assert.equal(res.code, 'DEAL_INVALID_TYPE');
  }
  // Регистр и пробелы по краям не должны ломать валидное значение.
  for (const good of ['direct', 'partner', 'DIRECT', '  Partner  ']) {
    assert.deepEqual(validateDealInput({ ...FULL, deal_type: good }), { ok: true }, good);
  }
});

test('несколько недостающих полей перечисляются все сразу', () => {
  const res = validateDealInput({ status_id: 's1', title: 'ООО Ромашка' });
  assert.equal(res.ok, false);
  assert.equal(res.missing.length, DEAL_REQUIRED_FIELDS.length - 2);
  // Агент должен увидеть весь список, а не исправлять по одному полю за раз.
  assert.match(res.error, /источник сделки/);
  assert.match(res.error, /ИНН компании/);
  assert.match(res.error, /контактное лицо/);
});

test('схема типов и набор полей согласованы с реестром', () => {
  assert.deepEqual(DEAL_TYPES, ['direct', 'partner']);
  // Ключи обязательных полей не должны расходиться с тем, что реально
  // принимает weeek_create_deal — иначе контракт будет враньём.
  const { tools } = require('../src/mcp-skills/tools/30-weeek.js');
  const props = new Set(Object.keys(tools.weeek_create_deal.inputSchema.properties));
  for (const f of DEAL_REQUIRED_FIELDS) {
    assert.ok(props.has(f.key), `поле ${f.key} объявлено обязательным, но create_deal его не принимает`);
  }
});

test('normalizeRoleName схлопывает омоглифы и пробелы', () => {
  const { normalizeRoleName } = require('../src/mcp-skills/tools/30-weeek.js');
  // Латинская C неотличима от кириллической — «Cколково» и «Сколково» это одна воронка.
  assert.equal(normalizeRoleName('Cколково'), normalizeRoleName('Сколково'));
  assert.equal(normalizeRoleName('  Сколково  '), 'сколково');
  assert.equal(normalizeRoleName('Партнеры'), normalizeRoleName('партнеры'));
  // Опечатка «Парнтеры» НЕ равна «Партнеры» — это разные строки, и молча
  // привязывать их нельзя.
  assert.notEqual(normalizeRoleName('Парнтеры'), normalizeRoleName('Партнеры'));
});

test('suggestRoleName предлагает близкое, но не решает за оператора', () => {
  const { suggestRoleName } = require('../src/mcp-skills/tools/30-weeek.js');
  const s = suggestRoleName('Партнеры', ['Парнтеры', 'Консалтинг', 'Гранты']);
  assert.equal(s.name, 'Парнтеры');
  assert.ok(s.distance >= 1);
  // Совсем далёкое название подсказкой не становится — шумнее, чем полезно.
  assert.equal(suggestRoleName('Разработка ПО', ['Парнтеры']), null);
});
