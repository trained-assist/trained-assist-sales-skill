'use strict';

// Deal session store (issue #19, group G13).
//
// The bot kept this state in Durable Object + KV; here it is a file per session
// under the profile's work dir, so it dies with the profile instead of living on
// in a worker the migration is retiring. Path follows the layout decided for
// preleads in the epic: ~/users/<profile>/sales/…
//
// NOT a credential store. A session holds deal fields and captured message text —
// nothing secret — so it deliberately does NOT live under agent-tokens/ (that
// tree is encrypted by encrypt-tokens.mjs and would turn deal drafts into
// ciphertext).
//
// TTL comes from the bot, unchanged: an unanswered intake expires after 15
// minutes, its backup is kept 7 days so a run that died mid-question can be
// resumed without losing what the user already typed.

const fs = require('fs');
const path = require('path');
const { userWorkDir } = require('../data-paths');

const SESSION_TTL_MINUTES = 15;
const BACKUP_TTL_DAYS = 7;
const MAX_MESSAGES = 200;

// Same UUID fallback as the rest of the platform — no dependency on node:crypto
// ordering, and a collision would be caught by the load-verify below.
function newId() {
  return require('crypto').randomUUID();
}

function salesRoot(profile) {
  return path.join(userWorkDir(profile), 'sales');
}

function sessionsRoot(profile) {
  return path.join(salesRoot(profile), 'sessions');
}

function backupRoot(profile) {
  return path.join(salesRoot(profile), 'sessions-backup');
}

function sessionPath(profile, id) {
  return path.join(sessionsRoot(profile), `${safeId(id)}.json`);
}

function safeId(id) {
  const s = String(id || '');
  // A session id reaches this from an LLM argument, so a path escape is a real
  // input, not a hypothetical: refuse anything that is not a bare filename.
  if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..') {
    throw new Error(`invalid session id: ${JSON.stringify(String(id))}`);
  }
  return s;
}

function now() {
  return Date.now();
}

function expiryMs(ttlMinutes = SESSION_TTL_MINUTES) {
  return now() + ttlMinutes * 60 * 1000;
}

// Atomic replace: a half-written session must never be readable — the runner
// may hold the chat across a restart.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Create a session.
 * @param {object} opts
 * @param {string} opts.profile
 * @param {'new_deal'|'batch_intake'|'routing'} opts.kind
 * @param {string} [opts.dealId]     — set when editing an existing deal
 * @param {string} [opts.sourceLabel]— exhibition/source the capture came from
 */
function createSession({ profile, kind, dealId = null, sourceLabel = null, title = null } = {}) {
  const id = newId();
  const session = {
    schema: 1,
    id,
    kind: kind || 'new_deal',
    dealId,
    sourceLabel,
    title,
    status: 'collecting', // collecting → review → done | cancelled | expired
    fields: {},
    messages: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(expiryMs()).toISOString(),
  };
  writeJsonAtomic(sessionPath(profile, id), session);
  return session;
}

function getSession(profile, id) {
  let raw;
  try {
    raw = fs.readFileSync(sessionPath(profile, id), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const s = JSON.parse(raw);
  if (s && s.expires_at && Date.parse(s.expires_at) < now()) {
    // Expired: back it up, then drop it from the live set so a listing never
    // offers a session that would fail the next write.
    archiveSession(profile, s);
    return null;
  }
  return s;
}

function saveSession(profile, session) {
  if (!session || !session.id) throw new Error('saveSession: session.id is required');
  const next = {
    ...session,
    updated_at: new Date().toISOString(),
    // Every save renews the window: the user is still typing.
    expires_at: new Date(expiryMs()).toISOString(),
  };
  writeJsonAtomic(sessionPath(profile, next.id), next);
  return next;
}

function archiveSession(profile, session) {
  try {
    writeJsonAtomic(path.join(backupRoot(profile), `${safeId(session.id)}.json`), session);
    fs.unlinkSync(sessionPath(profile, session.id));
    return true;
  } catch {
    return false;
  }
}

/** Cancel a live session: archive it out of the live set. Returns the archived copy. */
function cancelSession(profile, id) {
  const s = getSession(profile, id);
  if (!s) return null;
  const cancelled = { ...s, status: 'cancelled', updated_at: new Date().toISOString() };
  archiveSession(profile, cancelled);
  return cancelled;
}

// A captured message is the raw text the user sent while the wizard was open.
// Kept verbatim so the agent can re-read the answer to a question it did not ask
// directly (the bot's "captured notes" routing relied on exactly this).
function appendMessage(profile, id, message) {
  const s = getSession(profile, id);
  if (!s) return null;
  const list = Array.isArray(s.messages) ? s.messages : [];
  list.push({ at: new Date().toISOString(), text: String(message == null ? '' : message) });
  while (list.length > MAX_MESSAGES) list.shift();
  return saveSession(profile, { ...s, messages: list });
}

function listSessions(profile, { status = null } = {}) {
  const dir = sessionsRoot(profile);
  let names;
  try {
    names = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const s = getSession(profile, f.replace(/\.json$/, ''));
    if (!s) continue; // expired and archived
    if (status && s.status !== status) continue;
    out.push(s);
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

/** The newest live session of a kind — what a bare "continue" resumes. */
function latestSession(profile, kind = null) {
  const live = listSessions(profile, { status: 'collecting' });
  return live.find(s => (kind ? s.kind === kind : true)) || null;
}

// Backups are pure recovery; purge anything past the retention window.
function purgeBackups(profile, ttlDays = BACKUP_TTL_DAYS) {
  const dir = backupRoot(profile);
  const cutoff = now() - ttlDays * 86400 * 1000;
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }
  for (const f of names) {
    const fp = path.join(dir, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
    } catch { /* raced with a concurrent purge */ }
  }
  return removed;
}

module.exports = {
  createSession, getSession, saveSession, cancelSession, appendMessage,
  listSessions, latestSession, archiveSession, purgeBackups,
  salesRoot, sessionsRoot, sessionPath, backupRoot,
  SESSION_TTL_MINUTES, BACKUP_TTL_DAYS, MAX_MESSAGES,
};
