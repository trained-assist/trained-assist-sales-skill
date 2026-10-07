'use strict';
// G13 — deal session store, field registry, reference roles (issue #19).
// Pure units against a temp USERS_DIR / AGENT_TOKENS_DIR: no network, no Weeek,
// no writes outside the sandbox.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-g13-'));
process.env.USERS_DIR = path.join(TMP, 'users');
process.env.AGENT_TOKENS_DIR = path.join(TMP, 'tokens');
fs.mkdirSync(process.env.USERS_DIR, { recursive: true });
fs.mkdirSync(process.env.AGENT_TOKENS_DIR, { recursive: true });

const session = await import('../../src/sales/deal-session.js');
const fields = await import('../../src/sales/deal-fields.js');
const refs = await import('../../src/sales/deal-refs.js');
const exhi = await import('../../src/sales/exhibitions.js');

const PROFILE = 'g13-user';

afterEach(() => {
  for (const dir of [session.sessionsRoot(PROFILE), session.backupRoot(PROFILE)]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(refs.refsPath(PROFILE), { force: true });
});

// ── deal-session ────────────────────────────────────────────────────────────
describe('deal session store', () => {
  it('creates a collecting session readable from the profile', () => {
    const s = session.createSession({ profile: PROFILE, kind: 'new_deal' });
    expect(s.id).toBeTruthy();
    expect(s.kind).toBe('new_deal');
    expect(s.status).toBe('collecting');
    expect(s.fields).toEqual({});
    expect(fs.existsSync(session.sessionPath(PROFILE, s.id))).toBe(true);
  });

  it('keeps sessions out of the token tree — they are data, not secrets', () => {
    session.createSession({ profile: PROFILE });
    expect(fs.existsSync(path.join(process.env.AGENT_TOKENS_DIR, PROFILE, 'sales'))).toBe(false);
  });

  it('rejects a path-escaping session id — the id arrives from an LLM argument', () => {
    expect(() => session.sessionPath(PROFILE, '../escape')).toThrow(/invalid session id/);
    expect(() => session.sessionPath(PROFILE, 'a/b')).toThrow(/invalid session id/);
    expect(() => session.sessionPath(PROFILE, '..')).toThrow(/invalid session id/);
    expect(() => session.sessionPath(PROFILE, '')).toThrow(/invalid session id/);
  });

  it('renews the expiry window on every save', () => {
    const s = session.createSession({ profile: PROFILE });
    // Age it explicitly rather than sleeping: the assertion must not depend on
    // how fast the machine happens to run the two calls.
    const stale = { ...s, expires_at: new Date(Date.now() - 60_000).toISOString() };
    const saved = session.saveSession(PROFILE, stale);
    expect(Date.parse(saved.expires_at)).toBeGreaterThan(Date.now());
    expect(session.getSession(PROFILE, s.id).fields).toBeDefined();
  });

  it('keeps message order and caps the buffer', () => {
    const s = session.createSession({ profile: PROFILE });
    session.appendMessage(PROFILE, s.id, 'первое');
    session.appendMessage(PROFILE, s.id, 'второе');
    expect(session.getSession(PROFILE, s.id).messages.map(m => m.text)).toEqual(['первое', 'второе']);

    for (let i = 0; i < session.MAX_MESSAGES + 5; i++) session.appendMessage(PROFILE, s.id, `m${i}`);
    const msgs = session.getSession(PROFILE, s.id).messages;
    expect(msgs.length).toBe(session.MAX_MESSAGES);
    expect(msgs[msgs.length - 1].text).toBe(`m${session.MAX_MESSAGES + 4}`);
  });

  it('archives an expired session instead of listing it', () => {
    const s = session.createSession({ profile: PROFILE });
    const fp = session.sessionPath(PROFILE, s.id);
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    raw.expires_at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(fp, JSON.stringify(raw));

    expect(session.getSession(PROFILE, s.id)).toBeNull();
    expect(session.listSessions(PROFILE).some(x => x.id === s.id)).toBe(false);
    expect(fs.existsSync(path.join(session.backupRoot(PROFILE), `${s.id}.json`))).toBe(true);
  });

  it('cancelSession archives and clears the live entry', () => {
    const s = session.createSession({ profile: PROFILE });
    const out = session.cancelSession(PROFILE, s.id);
    expect(out.status).toBe('cancelled');
    expect(session.getSession(PROFILE, s.id)).toBeNull();
  });

  it('latestSession resumes the newest collecting session of a kind', () => {
    const a = session.createSession({ profile: PROFILE, kind: 'new_deal' });
    const b = session.createSession({ profile: PROFILE, kind: 'batch_intake' });
    const c = session.createSession({ profile: PROFILE, kind: 'new_deal' });
    // Avoid relying on wall-clock millisecond resolution: persist deliberately
    // ordered timestamps so the test checks newest-session behavior, not UUID
    // ordering when several sessions are created within one millisecond.
    for (const [item, updatedAt] of [
      [a, '2026-01-01T00:00:00.000Z'],
      [b, '2026-01-01T00:00:01.000Z'],
      [c, '2026-01-01T00:00:02.000Z'],
    ]) {
      const file = session.sessionPath(PROFILE, item.id);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      stored.updated_at = updatedAt;
      fs.writeFileSync(file, JSON.stringify(stored));
    }
    expect(session.latestSession(PROFILE, 'batch_intake').id).toBe(b.id);
    expect(session.latestSession(PROFILE, 'new_deal').id).toBe(c.id);
    expect([a.id, b.id, c.id]).toContain(session.latestSession(PROFILE).id);
  });

  it('purges backups past the retention window', () => {
    const s = session.createSession({ profile: PROFILE });
    session.cancelSession(PROFILE, s.id);
    const bp = path.join(session.backupRoot(PROFILE), `${s.id}.json`);
    const old = new Date(Date.now() - (session.BACKUP_TTL_DAYS + 2) * 86400 * 1000);
    fs.utimesSync(bp, old, old);
    expect(session.purgeBackups(PROFILE)).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(bp)).toBe(false);
  });
});

// ── deal-fields ─────────────────────────────────────────────────────────────
describe('deal field registry', () => {
  it('validates each field by type and rejects unknown names', () => {
    expect(fields.validateField('title', 'Пилот')).toBe('Пилот');
    expect(() => fields.validateField('nope', 'x')).toThrow(/unknown deal field/);
    expect(() => fields.validateField('source', 'выставка')).toThrow(/must be one of/);
    expect(fields.validateField('source', 'conference')).toBe('conference');
    expect(() => fields.validateField('eventKey', 'notanexpo')).toThrow(/known event_key/);
    expect(fields.validateField('eventKey', 'rosupack2026')).toBe('rosupack2026');
    expect(() => fields.validateField('telegramAccount', 'workacc')).toThrow(/must be one of/);
  });

  it('maps a blank value to null — that is the "skip this field" path', () => {
    expect(fields.validateField('nextTaskTitle', '   ')).toBeNull();
    expect(fields.validateField('nextTaskTitle', null)).toBeNull();
  });

  it('applyFields clears a field on null and leaves the rest alone', () => {
    const bag = fields.applyFields({}, { title: 'Пилот', nextTaskTitle: 'Позвонить' });
    const cleared = fields.applyFields(bag, { nextTaskTitle: null });
    expect('nextTaskTitle' in cleared).toBe(false);
    expect(cleared.title).toBe('Пилот');
  });

  it('missingRequired names exactly the required-and-absent fields', () => {
    const req = refs.DEAL_REQUIREMENTS;
    const bag = {
      title: 'Пилот', companyInfo: 'ООО Ромашка', contactName: 'Иван',
      source: 'personal', dealType: 'personal', dealComment: 'звонок',
    };
    expect(fields.missingRequired(bag, req)).toEqual([]);
    expect(fields.isComplete(bag, req)).toBe(true);
    expect(fields.missingRequired({}, req))
      .toEqual(['title', 'companyInfo', 'contactName', 'source', 'dealType', 'dealComment']);
    expect(fields.missingRequired(bag, req)).not.toContain('contactPhone');
  });

  it('nextMissing follows the bot asking order, not the field map order', () => {
    const bag = {
      title: 'Пилот', companyInfo: 'ООО', contactName: 'Иван',
      dealType: 'personal', dealComment: 'x',
    };
    expect(fields.nextMissing(bag, refs.DEAL_REQUIREMENTS)).toBe('source');
  });
});

// ── deal-refs ───────────────────────────────────────────────────────────────
describe('Weeek reference roles', () => {
  it('throws until the profile maps a role — never guesses an ID', () => {
    expect(() => refs.resolveRef(PROFILE, 'source', 'conference')).toThrow(/not mapped/);
    refs.saveRefs({ source: { conference: 'opt-1' }, dealType: { personal: 'opt-2' } }, PROFILE);
    expect(refs.resolveRef(PROFILE, 'source', 'conference')).toBe('opt-1');
    expect(refs.resolveRef(PROFILE, 'dealType', 'personal')).toBe('opt-2');
    expect(() => refs.resolveRef(PROFILE, 'source', 'partner')).toThrow(/not mapped/);
  });

  it('reads a corrupt or non-object refs file as empty instead of throwing', () => {
    fs.mkdirSync(path.dirname(refs.refsPath(PROFILE)), { recursive: true });
    fs.writeFileSync(refs.refsPath(PROFILE), 'not json', 'utf8');
    expect(refs.loadRefs(PROFILE)).toEqual({});
    fs.writeFileSync(refs.refsPath(PROFILE), '[]', 'utf8');
    expect(refs.loadRefs(PROFILE)).toEqual({});
  });

  it('unmappedGroups lists what weeek_set_refs still needs', () => {
    refs.saveRefs({ source: { conference: 'o1' } }, PROFILE);
    const gaps = refs.unmappedGroups(PROFILE);
    expect(gaps.find(g => g.kind === 'source').missing).toEqual(['personal', 'partner']);
  });

  it('resolves refs under AGENT_TOKENS_DIR, never the real home tree', () => {
    expect(refs.refsPath(PROFILE).startsWith(process.env.AGENT_TOKENS_DIR)).toBe(true);
  });
});

// ── exhibitions ─────────────────────────────────────────────────────────────
describe('exhibition keys', () => {
  it('knows the roster and falls back to the key for an unknown one', () => {
    expect(exhi.EVENT_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(exhi.isKnownEvent('rosupack2026')).toBe(true);
    expect(exhi.isKnownEvent('nope2026')).toBe(false);
    expect(exhi.eventName('rosupack2026')).toBe('RosUpack 2026');
    expect(exhi.eventName('nope2026')).toBe('nope2026');
  });
});
