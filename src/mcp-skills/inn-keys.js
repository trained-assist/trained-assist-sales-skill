'use strict';

// One store, one reader for DaData / Checko / Rusprofile credentials (#1885 ¶3).
//
// Store: <AGENT_TOKENS_DIR>/<user>/inn/config.json — written by inn_set_* and
// company_set_dadata_token, read by inn_*, dadata_*, checko_*, company_*.
// Precedence per key: the user's own key > platform env > nothing.
// Keys saved by older code in other places stay readable (read-only fallback,
// below the store): <OS home>/agent-tokens/<u>/inn/config.json,
// <tokens>/<u>/dadata (plain token, old company_set_dadata_token),
// <USERS_DIR>/<u>/.inn-config.json.
//
// Lives outside tools/ so the registry does not load it as a tool module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { tokensRoot, userWorkDir } = require('../data-paths');

const CREDENTIAL_KEYS = ['dadataToken', 'dadataSecret', 'checkoKey', 'rusprofileCookie'];

const uidOf = (userId) => String(userId || process.env.USER_ID || '');

function storePath(userId) {
  return path.join(tokensRoot(), uidOf(userId), 'inn', 'config.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function readPlain(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

function readStore(userId) {
  return readJson(storePath(userId));
}

// Old locations, most specific first. Only consulted for keys the store lacks.
function readLegacy(userId) {
  const u = uidOf(userId);
  const out = {};
  const layers = [
    readJson(path.join(os.homedir(), 'agent-tokens', u, 'inn', 'config.json')),
    { dadataToken: readPlain(path.join(tokensRoot(), u, 'dadata')) },
    { dadataToken: readPlain(path.join(os.homedir(), 'agent-tokens', u, 'dadata')) },
    readJson(path.join(userWorkDir(u), '.inn-config.json')),
  ];
  for (const layer of layers) {
    for (const k of CREDENTIAL_KEYS) if (!out[k] && layer[k]) out[k] = layer[k];
  }
  return out;
}

// Platform credentials from env vars (set via secrets.env / GCP Secret Manager)
function platformKeys() {
  return {
    dadataToken:      process.env.INN_DADATA_TOKEN  || process.env.DADATA_TOKEN  || null,
    dadataSecret:     process.env.INN_DADATA_SECRET || process.env.DADATA_SECRET || null,
    checkoKey:        process.env.INN_CHECKO_KEY    || process.env.CHECKO_KEY    || null,
    rusprofileCookie: process.env.INN_RUSPROFILE_COOKIE || null,
  };
}

// Merged view: { dadataToken, dadataSecret, checkoKey, rusprofileCookie, _sources }.
function readKeys(userId) {
  const user = { ...readLegacy(userId) };
  const stored = readStore(userId);
  for (const k of CREDENTIAL_KEYS) if (stored[k]) user[k] = stored[k];
  const platform = platformKeys();
  const out = { _sources: {} };
  for (const k of CREDENTIAL_KEYS) {
    if (user[k])          { out[k] = user[k];     out._sources[k] = 'user'; }
    else if (platform[k]) { out[k] = platform[k]; out._sources[k] = 'platform'; }
    else out[k] = null;
  }
  return out;
}

function writeKeys(userId, patch) {
  const file = storePath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readStore(userId), ...patch }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = { CREDENTIAL_KEYS, storePath, readKeys, writeKeys };
