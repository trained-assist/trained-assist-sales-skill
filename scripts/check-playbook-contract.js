'use strict';

// Validates every playbooks/*.json against the Playbook v1 contract owned by
// trained-assist-agent (contracts/playbook.schema.json, via its PlaybookStore
// validator). The core checkout is expected at `.core` — CI checks it out right
// before this step; locally run `git clone --depth 1 ... .core` or skip with
// PLAYBOOK_CONTRACT_STRICT=0.
//
// Why this gate lives here: this repo owns the Flexi sales playbook. If the
// playbook drifts from the contract, the core silently refuses to resolve it
// (unknown validation keys become `inconclusive` → LLM judge, and a malformed
// file drops the whole playbook), and the failure surfaces only at run time on
// a live exhibition. A schema check in CI catches it at PR time.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const playbooksDir = path.join(root, 'playbooks');
const coreStore = path.join(root, '.core', 'src', 'playbook-store.js');

function fail(message) {
  console.error(`check-playbook-contract: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(coreStore)) {
  const message = `no core checkout at ${path.relative(root, coreStore)} — cannot validate the Playbook v1 contract`;
  if (process.env.PLAYBOOK_CONTRACT_STRICT === '0') {
    console.warn(`SKIP ${message}`);
    process.exit(0);
  }
  fail(message);
}

const { validatePlaybook } = require(coreStore);
if (typeof validatePlaybook !== 'function') fail('core PlaybookStore does not export validatePlaybook');

const files = fs.existsSync(playbooksDir)
  ? fs.readdirSync(playbooksDir).filter((f) => f.endsWith('.json')).sort()
  : [];
if (!files.length) fail('no playbooks/*.json found — the sales playbook should live here');

let stages = 0;
let steps = 0;
for (const file of files) {
  const full = path.join(playbooksDir, file);
  let playbook;
  try {
    playbook = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    fail(`${file}: invalid JSON — ${e.message}`);
  }
  try {
    validatePlaybook(playbook);
  } catch (e) {
    fail(`${file}: ${e.message}`);
  }
  if (playbook.scope !== 'system') fail(`${file}: sibling repo playbooks must declare scope "system"`);
  const fileStages = (playbook.stages || []).length;
  const fileSteps = (playbook.stages || []).reduce((n, s) => n + (s.steps || []).length, 0);
  console.log(`ok ${playbook.id} v${playbook.version} — ${fileStages} stages / ${fileSteps} steps`);
  stages += fileStages;
  steps += fileSteps;
}

console.log(`check-playbook-contract: ${files.length} playbook(s), ${stages} stages, ${steps} steps — OK`);
