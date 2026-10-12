'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const attempts = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = parent?.filename || '';
  if (from.endsWith('/src/inn-pipeline/index.js')) {
    if (request === './sources/bfo') return {
      enrichViaBfo: async (company) => {
        attempts.push(company.id);
        if (company.id === 'missing') return null;
        return {
          inn: '7701234567', ogrn: '1027700123456',
          revenue_mln: 300, revenue_year: 2025, requisites_source: 'bfo',
        };
      },
    };
    if (request === './sources/egrul') return { egrulLookup: async () => null };
    if (request === './lib/usage-log') return { logCall: () => {} };
  }
  if (from.endsWith('/src/mcp-skills/tools/70-inn-enrichment.js') && request === '../inn-keys') {
    return { readKeys: () => ({}), writeKeys: () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { inn_enrich_batch } = require('../src/mcp-skills/tools/70-inn-enrichment.js').tools;
Module._load = originalLoad;

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inn-batch-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('real pipeline object shape resumes 25 companies in batches of 2 without false completion', () => fixture(async dir => {
  attempts.length = 0;
  const companies = Array.from({ length: 25 }, (_, i) => ({ id: `co-${i}`, name: `Компания ${i}`, stand: `A${i}` }));
  const args = { companies, out_dir: dir, batch_size: 2 };
  const first = await inn_enrich_batch.handler(args, {});
  assert.equal(first.done, 2);
  assert.equal(first.remaining, 23);
  assert.equal(first.with_inn, 2);
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'enriched.json')));
  assert.equal(saved.length, 25);
  assert.equal(saved[0].revenue_mln, 300);
  assert.equal(saved[0].stand, 'A0');
  assert.equal(saved[2]._inn_enrichment.status, 'pending');

  let current = first;
  for (let i = 0; i < 12; i++) current = await inn_enrich_batch.handler(args, {});
  assert.equal(current.done, 25);
  assert.equal(current.remaining, 0);
  assert.equal(current.with_inn, 25);
  assert.equal(attempts.length, 25);
  assert.equal(new Set(attempts).size, 25);
  const repeated = await inn_enrich_batch.handler(args, {});
  assert.equal(repeated.done, 25);
  assert.equal(repeated.with_inn, 25);
  assert.equal(attempts.length, 25);
  saved = JSON.parse(fs.readFileSync(path.join(dir, 'enriched.json')));
  assert.deepEqual(saved.map(c => c.id), companies.map(c => c.id));
}));

test('legacy raw rows are retried while proven completed rows are kept', () => fixture(async dir => {
  attempts.length = 0;
  const companies = [
    { id: 'old-checked', name: 'Совпадающее имя', requisites_source: 'bfo', inn: 'old-inn' },
    { id: 'old-raw', name: 'Совпадающее имя' },
    { id: 'missing', name: 'Без совпадения' },
  ];
  fs.writeFileSync(path.join(dir, 'enriched.json'), JSON.stringify(companies));
  const args = { companies, out_dir: dir, batch_size: 1 };
  const first = await inn_enrich_batch.handler(args, {});
  assert.equal(first.done, 2);
  assert.equal(first.remaining, 1);
  assert.deepEqual(attempts, ['old-raw']);
  const second = await inn_enrich_batch.handler(args, {});
  assert.equal(second.done, 3);
  assert.equal(second.remaining, 0);
  assert.deepEqual(attempts, ['old-raw', 'missing']);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'enriched.json')));
  assert.equal(saved[0].inn, 'old-inn');
  assert.equal(saved[1].revenue_mln, 300);
  assert.equal(saved[2]._inn_enrichment.status, 'unresolved');
}));

test('duplicate identities fail before any enrichment call', () => fixture(async dir => {
  attempts.length = 0;
  const response = await inn_enrich_batch.handler({
    companies: [{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }], out_dir: dir,
  }, {});
  assert.match(response.error, /уникальный/);
  assert.equal(attempts.length, 0);
}));
