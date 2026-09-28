'use strict';

// Validates every playbooks/*.json against the Playbook v1 contract owned by
// trained-assist-agent (contracts/playbook.schema.json). The core checkout is
// expected at `.core` — CI checks it out right before this step.
//
// Why not just `require('.core/src/playbook-store').validatePlaybook`: that
// module needs ajv from core's node_modules, which CI does not install for a
// sibling skill. validatePlaybook is exactly an Ajv compile of the schema
// (same options below) plus a scope check the loader applies by location, so
// this reproduces it without pulling core's dependency tree.
//
// Why the gate exists: this repo owns the Flexi sales playbook. A file that
// drifts from the contract makes core refuse it at resolution time — invisible
// until a live exhibition run.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const root = path.resolve(__dirname, '..');
const playbooksDir = path.join(root, 'playbooks');
const schemaPath = path.join(root, '.core', 'contracts', 'playbook.schema.json');

function fail(message) {
  console.error(`check-playbook-contract: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(schemaPath)) {
  const message = `no Playbook v1 schema at ${path.relative(root, schemaPath)} — check out trained-assist-agent into .core first`;
  if (process.env.PLAYBOOK_CONTRACT_STRICT === '0') {
    console.warn(`SKIP ${message}`);
    process.exit(0);
  }
  fail(message);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validate = ajv.compile(schema);

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
  if (!validate(playbook)) {
    const details = (validate.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    fail(`${file}: ${details}`);
  }
  // Sibling-repo playbooks are repo-owned, so the loader only accepts them as
  // `system` scope (a `profile` file here would silently shadow nothing useful
  // and never resolve).
  if (playbook.scope !== 'system') fail(`${file}: sibling repo playbooks must declare scope "system"`);

  const fileStages = (playbook.stages || []).length;
  const fileSteps = (playbook.stages || []).reduce((n, s) => n + (s.steps || []).length, 0);
  console.log(`ok ${playbook.id} v${playbook.version} — ${fileStages} stages / ${fileSteps} steps`);
  stages += fileStages;
  steps += fileSteps;
}

console.log(`check-playbook-contract: ${files.length} playbook(s), ${stages} stages, ${steps} steps — OK`);
