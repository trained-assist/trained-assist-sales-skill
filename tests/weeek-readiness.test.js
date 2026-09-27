'use strict';
// 30-weeek (moved from trained-assist-agent core, #1470): without a token only the
// setup tools are exposed; with a token file in the profile's agent-tokens dir the
// whole CRM tool set is.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function listTools(home) {
  const r = spawnSync(process.execPath, ['-e',
    "const r=require('./src/mcp-skills/registry.js');console.log(JSON.stringify({ready:r.listTools().map(t=>t.name),all:r.listAllTools().map(t=>t.name)}))"],
    { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USER_ID: 'u1', AGENT_TOKENS_DIR: '' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('not connected → only weeek_status / weeek_set_token; static catalog has everything', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weeek-'));
  const { ready, all } = listTools(home);
  assert.deepEqual(ready.filter(n => n.startsWith('weeek_')).sort(), ['weeek_set_token', 'weeek_status']);
  assert.ok(all.includes('weeek_create_deal') && all.includes('weeek_list_contacts'));
});

test('token present → full CRM tool set', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weeek-'));
  fs.mkdirSync(path.join(home, 'agent-tokens', 'u1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agent-tokens', 'u1', 'weeek'), 'fixture-token', { mode: 0o600 });
  const { ready } = listTools(home);
  assert.ok(ready.includes('weeek_create_deal') && ready.includes('weeek_add_task'));
});
