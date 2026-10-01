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
