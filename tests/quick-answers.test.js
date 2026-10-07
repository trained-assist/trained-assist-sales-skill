'use strict';
// Expo quick answers + project type moved from core (trained-assist-agent #1717).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getQuickAnswer } = require('../src/quick-answers');
const projectTypes = require('../src/project-types');

function profile({ pipeline = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-quick-'));
  if (pipeline) {
    const ev = path.join(dir, 'expo-pipeline', 'flowers2026');
    fs.mkdirSync(ev, { recursive: true });
    fs.writeFileSync(path.join(ev, 'companies.json'), JSON.stringify([{}, {}, {}]));
    fs.writeFileSync(path.join(ev, 'targets.json'), JSON.stringify({ companies: [{}] }));
  }
  return dir;
}

test('no expo-pipeline → never answers', () => {
  const workDir = profile({ pipeline: false });
  assert.equal(getQuickAnswer('умеешь собирать участников выставки?', { workDir }), null);
  assert.equal(getQuickAnswer('статус pipeline', { workDir }), null);
  assert.equal(getQuickAnswer('статус pipeline', {}), null);
});

test('capability phrasings answer; real expo tasks are not intercepted', () => {
  const workDir = profile();
  for (const task of [
    'умеешь собрать участников выставки?',
    'можешь собрать список экспонентов?',
    'умеешь собрать участников выставки и обогатить по ИНН?',
    'есть скил для сбора участников выставки?',
    'есть инструмент для экспонентов?',
    'умеешь парсить участников expo?',
  ]) assert.match(getQuickAnswer(task, { workDir }) || '', /выставок/, task);
  for (const task of [
    'собери список участников с этого сайта https://aquatherm.ru',
    'отлично! вот сайт выставки — https://aquatherm.ru — собери список участников в CSV',
    'зайди на страницу участников выставки и скачай список',
    'найди участников на сайте выставки agros.org.ru',
  ]) assert.equal(getQuickAnswer(task, { workDir }), null, task);
});

test('capability answer only outside an active session', () => {
  const workDir = profile();
  assert.match(getQuickAnswer('умеешь собирать участников выставки?', { workDir }), /участников выставок/);
  assert.equal(getQuickAnswer('умеешь собирать участников выставки?', { workDir, sessionExists: true }), null);
});

test('status counts pipeline files', () => {
  const out = getQuickAnswer('статус pipeline', { workDir: profile() });
  assert.match(out, /flowers2026/);
  assert.match(out, /Компаний: 3 \| Обогащено: — \| Целевых: 1/);
});

test('criteria and site config read from disk', () => {
  const workDir = profile();
  assert.equal(typeof getQuickAnswer('покажи критерии', { workDir }), 'string');
  assert.equal(typeof getQuickAnswer('какие диапазоны на сайте', { workDir }), 'string');
  assert.equal(getQuickAnswer('покажи критерии ' + 'x'.repeat(250), { workDir }), null);
});

test('unrelated message → null', () => {
  assert.equal(getQuickAnswer('привет', { workDir: profile() }), null);
});

test('expo project type has the core TYPES schema', () => {
  const t = projectTypes.expo;
  assert.equal(t.label, 'Выставка');
  assert.ok(t.prefixes.includes('выставка'));
  assert.ok(Array.isArray(t.dirs) && t.seedFiles['EVENT.md'] && t.profile);
});

// ── Команды CRM ──────────────────────────────────────────────────────────────
//
// Быстрый ответ по контракту ядра синхронный и без сети, поэтому сюда попадает
// только локальная проверка токена. Сами вызовы Weeek уходят в агента.

function crmProfile({ token } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-quick-crm-'));
  const prevTokens = process.env.AGENT_TOKENS_DIR;
  const prevUser = process.env.USER_ID;
  process.env.AGENT_TOKENS_DIR = dir;
  process.env.USER_ID = 'u1';
  fs.mkdirSync(path.join(dir, 'u1'), { recursive: true });
  if (token) fs.writeFileSync(path.join(dir, 'u1', 'weeek'), 'fake-token');
  return {
    dir,
    restore() {
      if (prevTokens === undefined) delete process.env.AGENT_TOKENS_DIR;
      else process.env.AGENT_TOKENS_DIR = prevTokens;
      if (prevUser === undefined) delete process.env.USER_ID;
      else process.env.USER_ID = prevUser;
    },
  };
}

test('команда CRM отвечается и без expo-pipeline', () => {
  const p = crmProfile({ token: true });
  try {
    // Регрессия: общий гейт «нет пайплайна — не наше» делал ответ недостижимым.
    assert.equal(fs.existsSync(path.join(p.dir, 'expo-pipeline')), false);
    const out = getQuickAnswer('/deals', { workDir: p.dir });
    assert.equal(typeof out, 'string');
    assert.match(out, /CRM/);
  } finally { p.restore(); }
});

test('без токена CRM честно говорит, что не подключена', () => {
  const p = crmProfile();
  try {
    assert.match(getQuickAnswer('/deals', { workDir: p.dir }), /не подключена/);
    assert.match(getQuickAnswer('CRM подключена?', { workDir: p.dir }), /токена нет/);
  } finally { p.restore(); }
});

test('с токеном — список команд, а не обещание', () => {
  const p = crmProfile({ token: true });
  try {
    const out = getQuickAnswer('/deals', { workDir: p.dir });
    assert.match(out, /\/deals/);
    assert.match(out, /\/add_status/);
    assert.match(out, /\/preleads/);
  } finally { p.restore(); }
});

test('свободный текст не перехватывается — уходит в агента', () => {
  const p = crmProfile({ token: true });
  try {
    for (const task of [
      'добавь контакт Иван +7 900 000',
      'создай сделку на Эксимпак',
      'кинь визитку в сделку',
      'поменяй статус на Вызвано',
    ]) {
      assert.equal(getQuickAnswer(task, { workDir: p.dir }), null, task);
    }
  } finally { p.restore(); }
});

test('ответ про CRM не зависит от наличия выставки', () => {
  const p = crmProfile({ token: true });
  try {
    // Профиль без expo-pipeline: ответ обязан работать, это не про выставку.
    assert.equal(getQuickAnswer('есть ли доступ к CRM', { workDir: p.dir }).includes('подключена'), true);
  } finally { p.restore(); }
});
