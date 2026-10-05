'use strict';

// Regression test (issue #1885 ¶3): DaData/Checko keys are split across 3 stores.
//
// The documented setters inn_set_dadata_token / inn_set_checko_key write
// <tokens>/<user>/inn/config.json, but the dadata_* / checko_* / company_* readers
// look in other places, so a user's own key is silently ignored.
//
// Contract under test: key saved via inn_set_* must be readable by dadata_* and
// checko_* (one store, one reader). Right now this is RED — that is the repro.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-keys-test-'));
const USER = 't-user';

const savedEnv = {};
function setEnv(name, value) {
  if (!savedEnv[name]) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const __tools = {};

beforeAll(async () => {
  setEnv('HOME', SANDBOX);
  setEnv('USERS_DIR', path.join(SANDBOX, 'users'));
  setEnv('AGENT_TOKENS_DIR', path.join(SANDBOX, 'agent-tokens'));
  setEnv('AGENT_DATA_DIR', path.join(SANDBOX, 'agent-data'));
  // Prod contract: the registry passes ctx.userId = process.env.USER_ID, and
  // tool modules capture USER_ID at load — so the setter and the readers see one user.
  setEnv('USER_ID', USER);
  for (const k of ['INN_DADATA_TOKEN', 'INN_DADATA_SECRET', 'DADATA_TOKEN',
                   'DADATA_SECRET', 'INN_CHECKO_KEY', 'CHECKO_KEY', 'INN_RUSPROFILE_COOKIE']) {
    setEnv(k, undefined);
  }

  // Modules capture USER_ID at load time — import only after env is set.
  __tools.innTools = (await import('../../src/mcp-skills/tools/70-inn-enrichment.js')).tools;
  __tools.dadataTools = (await import('../../src/mcp-skills/tools/71-dadata.js')).tools;
  __tools.checkoTools = (await import('../../src/mcp-skills/tools/72-checko.js')).tools;
  __tools.companyTools = (await import('../../src/mcp-skills/tools/40-company.js')).tools;
}, 15000);

// No network: record which key each outbound call carried.
let calls = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization || null });
    return { ok: true, status: 200, json: async () => ({ suggestions: [] }), text: async () => '' };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('one store, one reader — keys set via inn_set_* are seen by dadata_*/checko_*', () => {
  it('dadata_suggest does NOT say "not configured" after inn_set_dadata_token', async () => {
    const { innTools, dadataTools } = __tools;
    const res = await innTools.inn_set_dadata_token.handler(
      { token: 'test-user-token', secret: 'test-user-secret' },
      { userId: USER }
    );
    expect(res.ok).toBe(true);

    const store = path.join(SANDBOX, 'agent-tokens', USER, 'inn', 'config.json');
    expect(fs.existsSync(store)).toBe(true);

    const suggest = await dadataTools.dadata_suggest.handler({ query: 'ООО Тест' });
    expect(calls[0]?.auth).toBe('Token test-user-token');
    // Bug: user key is written but ignored → "DaData token not configured."
    expect(suggest.error || '').not.toMatch(/not configured/i);
  }, 15000);

  it('checko_discover reports key_configured=true after inn_set_checko_key', async () => {
    const { innTools, checkoTools } = __tools;
    const res = await innTools.inn_set_checko_key.handler({ key: 'test-checko-key' }, { userId: USER });
    expect(res.ok).toBe(true);

    const disco = await checkoTools.checko_discover.handler({});
    expect(disco.key_configured).toBe(true);
  }, 15000);
});

const TOKENS = () => path.join(SANDBOX, 'agent-tokens');
const store = () => path.join(TOKENS(), USER, 'inn', 'config.json');
function reset() {
  fs.rmSync(TOKENS(), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, 'users'), { recursive: true, force: true });
  for (const k of ['INN_DADATA_TOKEN', 'INN_CHECKO_KEY']) setEnv(k, undefined);
}

describe('precedence: the user\'s own key beats the platform key', () => {
  beforeEach(reset);

  it('platform env is used when the user has no key', async () => {
    setEnv('INN_DADATA_TOKEN', 'platform-token');
    await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    expect(calls[0].auth).toBe('Token platform-token');
  });

  it('user key saved via inn_set_dadata_token overrides platform env', async () => {
    setEnv('INN_DADATA_TOKEN', 'platform-token');
    await __tools.innTools.inn_set_dadata_token.handler({ token: 'mine', secret: 's' }, { userId: USER });
    await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    expect(calls[0].auth).toBe('Token mine');
  });

  it('checko: user key overrides platform env', async () => {
    setEnv('INN_CHECKO_KEY', 'platform-checko');
    await __tools.innTools.inn_set_checko_key.handler({ key: 'my-checko' }, { userId: USER });
    await __tools.checkoTools.read_checko_company_data.handler({ endpoint: 'company', inn: '7707083893' });
    expect(calls[0].url).toContain('key=my-checko');
  });
});

describe('company_* reads the same store', () => {
  beforeEach(reset);

  it('company_find_by_name uses the key saved via inn_set_dadata_token', async () => {
    await __tools.innTools.inn_set_dadata_token.handler({ token: 'mine', secret: 's' }, { userId: USER });
    const r = await __tools.companyTools.company_find_by_name.handler({ query: 'Тест' });
    expect(r.source).toBe('dadata');
    expect(calls[0].auth).toBe('Token mine');
  });

  it('company_set_dadata_token writes the one store, seen by dadata_*', async () => {
    const r = await __tools.companyTools.company_set_dadata_token.handler({ token: 'via-company' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(store(), 'utf8')).dadataToken).toBe('via-company');
    expect(fs.statSync(store()).mode & 0o777).toBe(0o600);
    await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    expect(calls[0].auth).toBe('Token via-company');
  });
});

describe('existing keys in old places stay readable', () => {
  beforeEach(reset);

  it('legacy agent-tokens/<u>/dadata plain file is read by dadata_* and company_*', async () => {
    fs.mkdirSync(path.join(TOKENS(), USER), { recursive: true });
    fs.writeFileSync(path.join(TOKENS(), USER, 'dadata'), 'legacy-plain\n');
    await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    const r = await __tools.companyTools.company_find_by_name.handler({ query: 'Тест' });
    expect(r.source).toBe('dadata');
    expect(calls.map(c => c.auth)).toEqual(['Token legacy-plain', 'Token legacy-plain']);
  });

  it('legacy users/<u>/.inn-config.json is read by checko_*', async () => {
    fs.mkdirSync(path.join(SANDBOX, 'users', USER), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, 'users', USER, '.inn-config.json'), JSON.stringify({ checkoKey: 'legacy-checko' }));
    const d = await __tools.checkoTools.checko_discover.handler({});
    expect(d.key_configured).toBe(true);
  });

  it('the one store wins over legacy files', async () => {
    fs.mkdirSync(path.join(TOKENS(), USER), { recursive: true });
    fs.writeFileSync(path.join(TOKENS(), USER, 'dadata'), 'legacy-plain');
    await __tools.innTools.inn_set_dadata_token.handler({ token: 'new', secret: 's' }, { userId: USER });
    await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    expect(calls[0].auth).toBe('Token new');
  });
});

describe('the store lives under AGENT_TOKENS_DIR, not the OS home', () => {
  beforeEach(reset);

  it('inn_set_* writes under AGENT_TOKENS_DIR even when HOME points elsewhere', async () => {
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-keys-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = otherHome;
    try {
      await __tools.innTools.inn_set_checko_key.handler({ key: 'k' }, { userId: USER });
      expect(fs.existsSync(store())).toBe(true);
      expect(fs.existsSync(path.join(otherHome, 'agent-tokens'))).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

describe('hints point to a setter that works', () => {
  beforeEach(reset);

  it('checko_* and dadata_* name inn_set_* when no key is found', async () => {
    const c1 = await __tools.checkoTools.read_checko_company_data.handler({ endpoint: 'company', inn: '7707083893' });
    const c2 = await __tools.checkoTools.checko_qualify.handler({ inn: '7707083893' });
    const d1 = await __tools.companyTools.company_get_by_inn.handler({ inn: '7707083893' });
    expect(c1.error).toMatch(/inn_set_checko_key/);
    expect(c2.error).toMatch(/inn_set_checko_key/);
    expect(d1.error).toMatch(/inn_set_dadata_token/);
  });
});
