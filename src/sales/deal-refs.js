'use strict';

// Deal reference data (issue #19) — roles, and the Weeek IDs behind them.
//
// TWO LAYERS, ON PURPOSE (decision recorded in the epic):
//
//   1. ROLES live here, as code. A closed set is a contract: an unknown source or
//      channel is a typed error the agent can correct, not a Weeek 400 four layers
//      down. Same pattern as CANDIDATE_STATUSES in trained-assist-hh-skill.
//
//   2. Weeek OPTION IDs live in the profile, in weeek-refs.json — under
//      agent-tokens/, because that is where every other Weeek-scoped fact already
//      is (the token in weeek, the L2 session in weeek-session, workspace_id
//      parsed out of the cookie in 30-weeek.js:71). IDs differ per workspace, so
//      hardcoding them here would bind the skill to one account.
//
// The exhibition list is already code — EVENT_NAMES in 92-flexi-sales.js. A deal
// that comes from an exhibition names the event_key, not a free-text source.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../data-paths');

const USER_ID = process.env.USER_ID || '';

// How a deal was sourced. The exhibition (event_key) is a separate field.
const SOURCE_KINDS = ['conference', 'personal', 'partner'];

// Direct vs partner, matching the bot's `deal_type_kind` column on preleads.
const DEAL_TYPES = ['personal', 'partner'];

// Where the client prefers to be reached. Telegram is the default path because
// the whole platform is Telegram-first; MAX and email come from the bot.
const COMMUNICATION_CHANNELS = ['telegram', 'max', 'email'];

// Which Telegram identity to write from — the bot forced the operator to pick
// work vs personal because the agent must not guess whose account a message goes from.
const TELEGRAM_ACCOUNTS = ['work', 'personal', 'other'];

/**
 * Default requirement set — the bot's WEEEK_REQUIRE_* vars, as policy data.
 * `false` here means "collect it when the user volunteers it, never block on it".
 */
const DEAL_REQUIREMENTS = {
  title: true,
  companyInfo: true,
  contactName: true,
  contactPhone: false,
  source: true,
  sourceComment: false,
  dealType: true,
  dealComment: true,
  dealStatus: false,
  nextTaskTitle: false,
  nextTaskDueText: false,
  communicationChannel: false,
  telegramAccount: false,
  telegramPeerId: false,
};

// Resolved through data-paths, NOT os.homedir(): the agent-tokens root is
// redirected by AGENT_TOKENS_DIR, and hardcoding the home directory makes a test
// write into the real token tree instead of its sandbox.
function refsPath(profile) {
  return path.join(tokensRoot(), String(profile || USER_ID), 'weeek-refs.json');
}

/**
 * Read the role → Weeek-ID map. Missing file is not an error: it means "this
 * workspace's IDs are not mapped yet", and callers must then ask the user rather
 * than guess. Never returns a partially-trusted object.
 */
function loadRefs(profile) {
  try {
    const v = JSON.parse(fs.readFileSync(refsPath(profile), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function saveRefs(refs, profile) {
  const p = refsPath(profile);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(refs, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

/**
 * Weeek option ID for a role value.
 * Throws when unmapped — an unmapped source must not be written as a broken
 * custom field, and the caller needs the role name to ask about.
 */
function resolveRef(profile, kind, value) {
  const refs = loadRefs(profile);
  const group = refs[kind];
  if (!group || typeof group !== 'object') {
    throw new Error(`Weeek reference group "${kind}" is not mapped for this profile — call weeek_set_refs first`);
  }
  const id = group[String(value)];
  if (!id) {
    throw new Error(`Weeek reference "${kind}.${value}" is not mapped for this profile — call weeek_set_refs first`);
  }
  return String(id);
}

/** Which of the role groups still lack a Weeek mapping. */
function unmappedGroups(profile) {
  const refs = loadRefs(profile);
  const groups = { source: SOURCE_KINDS, dealType: DEAL_TYPES };
  const out = [];
  for (const [kind, values] of Object.entries(groups)) {
    const group = refs[kind] || {};
    const missing = values.filter(v => !group[v]);
    if (missing.length) out.push({ kind, missing });
  }
  return out;
}

module.exports = {
  SOURCE_KINDS, DEAL_TYPES, COMMUNICATION_CHANNELS, TELEGRAM_ACCOUNTS,
  DEAL_REQUIREMENTS, refsPath,
  loadRefs, saveRefs, resolveRef, unmappedGroups,
};
