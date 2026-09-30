'use strict';
// trained-assist-agent#1939 (C4 rollout шаг 1): the sales credential files
// (`weeek`, `weeek-session`, `dadata`, `inn/config.json`) are read and written
// through credential-store, not raw fs — 30-weeek.js and inn-keys.js (the one
// store the dadata_*/checko_*/company_*/inn_* readers share).
//
// Contract (epic #1789 P0 C4, #1819):
//   - legacy plaintext files pass through transparently;
//   - an encrypted (v2 base64 envelope) file is decrypted;
//   - a base64 stub is NEVER returned as a value;
//   - a missing CRED_ENCRYPTION_KEY degrades to plaintext WITH a warning —
//     never a hard failure.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-cred-'));
const savedEnv = { HOME: process.env.HOME, USERS_DIR: process.env.USERS_DIR };
process.env.HOME = root;               // legacy lookups fall back to $HOME — sandbox it
process.env.USERS_DIR = path.join(root, 'users');
process.env.AGENT_TOKENS_DIR = root;
process.env.USER_ID = 'sales-user';
delete process.env.CRED_ENCRYPTION_KEY;
delete process.env.INN_DADATA_TOKEN;
delete process.env.INN_DADATA_SECRET;
delete process.env.DADATA_TOKEN;
delete process.env.DADATA_SECRET;
delete process.env.INN_CHECKO_KEY;
delete process.env.CHECKO_KEY;
delete process.env.INN_RUSPROFILE_COOKIE;

const store = require('../src/credential-store');
const weeek = require('../src/mcp-skills/tools/30-weeek');
const inn = require('../src/mcp-skills/inn-keys');

const MASTER_KEY = 'd'.repeat(64); // valid 64-hex → 32-byte AES-256 key
const profile = path.join(root, 'sales-user');
const weeekFile = path.join(profile, 'weeek');
const sessionFile = path.join(profile, 'weeek-session');
const innStore = path.join(profile, 'inn', 'config.json');
const legacyDadata = path.join(profile, 'dadata');

function reset(t) {
  const saved = process.env.CRED_ENCRYPTION_KEY;
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();
  fs.rmSync(profile, { recursive: true, force: true });
  t.after(() => {
    if (saved === undefined) delete process.env.CRED_ENCRYPTION_KEY;
    else process.env.CRED_ENCRYPTION_KEY = saved;
    store._resetMasterKey();
  });
}

function withKey() {
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();
}

function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }
}

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  store._resetMasterKey();
  fs.rmSync(root, { recursive: true, force: true });
});

test('legacy plaintext weeek token + session read through unchanged', (t) => {
  reset(t);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(weeekFile, 'weeek-legacy-token\n', 'utf8');
  fs.writeFileSync(sessionFile, 'WEEEK_SESSION=legacy', 'utf8');

  assert.equal(weeek.readToken(), 'weeek-legacy-token');
  assert.equal(weeek.readSession(), 'WEEEK_SESSION=legacy');
  assert.equal(weeek.isReady(), true);
});

test('missing CRED_ENCRYPTION_KEY → plaintext writes with a warning, never a failure', (t) => {
  reset(t);
  const { warnings } = captureWarn(() => weeek.writeToken(undefined, '  weeek-plain  '));

  assert.equal(fs.readFileSync(weeekFile, 'utf8'), 'weeek-plain');
  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  assert.equal(weeek.readToken(), 'weeek-plain');

  const { warnings: w2 } = captureWarn(() => inn.writeKeys('sales-user', { dadataToken: 'dadata-plain' }));
  assert.ok(w2.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${w2.join(' | ')}`);
  assert.equal(JSON.parse(fs.readFileSync(innStore, 'utf8')).dadataToken, 'dadata-plain');
  assert.equal(inn.readKeys('sales-user').dadataToken, 'dadata-plain');
});

test('double read: with a key the files are encrypted at rest and still read back', (t) => {
  reset(t);
  withKey();

  captureWarn(() => {
    weeek.writeToken(undefined, 'weeek-encrypted');
    store.writeCredentialFile(sessionFile, 'WEEEK_SESSION=encrypted');
    inn.writeKeys('sales-user', { dadataToken: 'dadata-encrypted', checkoKey: 'checko-encrypted' });
  });

  for (const [file, plaintext] of [[weeekFile, 'weeek-encrypted'], [sessionFile, 'WEEEK_SESSION=encrypted']]) {
    const raw = fs.readFileSync(file, 'utf8');
    assert.notEqual(raw, plaintext, `${file}: at rest must not hold the plaintext`);
    assert.ok(store.isEncrypted(raw), `${file}: at rest must be a v2 envelope`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${file}: must stay 0o600`);
  }
  const storeRaw = fs.readFileSync(innStore, 'utf8');
  assert.ok(store.isEncrypted(storeRaw), 'inn/config.json: at rest must be a v2 envelope');
  assert.equal(fs.statSync(innStore).mode & 0o777, 0o600, 'inn/config.json: must stay 0o600');

  assert.equal(weeek.readToken(), 'weeek-encrypted');
  assert.equal(weeek.readSession(), 'WEEEK_SESSION=encrypted');
  const keys = inn.readKeys('sales-user');
  assert.equal(keys.dadataToken, 'dadata-encrypted');
  assert.equal(keys.checkoKey, 'checko-encrypted');
  assert.equal(keys._sources.dadataToken, 'user');
});

test('legacy plaintext still reads through once a key IS set', (t) => {
  reset(t);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(weeekFile, 'weeek-still-legacy', 'utf8');
  fs.writeFileSync(legacyDadata, 'legacy-dadata-plain\n', 'utf8');
  withKey();

  assert.equal(weeek.readToken(), 'weeek-still-legacy');
  assert.equal(inn.readKeys('sales-user').dadataToken, 'legacy-dadata-plain');
});

test('a base64 stub is never returned as a value', (t) => {
  reset(t);
  withKey();
  captureWarn(() => {
    weeek.writeToken(undefined, 'weeek-stub');
    inn.writeKeys('sales-user', { dadataToken: 'dadata-stub' });
  });

  const weeekBlob = fs.readFileSync(weeekFile, 'utf8');
  const innBlob = fs.readFileSync(innStore, 'utf8');
  assert.ok(store.isEncrypted(weeekBlob), 'precondition: weeek file is a base64 stub');
  assert.ok(store.isEncrypted(innBlob), 'precondition: inn store is a base64 stub');

  // Key withdrawn: nothing below may hand the stub to the Weeek/DaData API.
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  assert.throws(() => store.readCredentialFile(weeekFile),
    /CRED_ENCRYPTION_KEY/, 'store-level: loud, no base64 garbage');
  const { warnings } = captureWarn(() => {
    assert.equal(weeek.readToken(), null, 'weeek: degrades to "no token", never the stub');
    assert.equal(weeek.isReady(), false, 'isReady must not throw on a stub either');
    assert.equal(inn.readKeys('sales-user').dadataToken, null, 'inn: degrades to "no key", never the stub');
  });
  assert.ok(warnings.some(w => /\[weeek\] cannot read the token/.test(w)),
    `expected a loud weeek warning, got: ${warnings.join(' | ')}`);
  assert.ok(warnings.some(w => /\[inn-keys\]/.test(w)),
    `expected a loud inn-keys warning, got: ${warnings.join(' | ')}`);
});

test('reading a missing credential file is silent and creates nothing', (t) => {
  reset(t);
  assert.equal(weeek.readToken(), null);
  assert.equal(weeek.readSession(), null);
  assert.deepEqual(inn.readKeys('sales-user').dadataToken, null);
  assert.ok(!fs.existsSync(profile), 'reading must not create a profile dir');
});
