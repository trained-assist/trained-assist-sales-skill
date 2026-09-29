'use strict';

// Regression test (issue #1885 ¶3): DaData/Checko keys are split across 3 stores.
//
// The documented setters inn_set_dadata_token / inn_set_checko_key write
// <tokens>/<user>/inn/config.json, but the dadata_* / checko_* / company_* readers
// look in other places, so a user's own key is silently ignored.
//
// Contract under test: key saved via inn_set_* must be readable by dadata_* and
// checko_* (one store, one reader). Right now this is RED — that is the repro.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
}, 15000);

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