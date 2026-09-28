'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { tools } = await import('../../src/mcp-skills/tools/92-flexi-sales.js');
const { flexi_delete_note, flexi_add_note } = tools;

let calls;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        deleted: 1,
        hasDeal: true,
        preleadId: 'site_rosupack2026_a12',
        notes: [{ id: 'site-note-1', text: '[ТЕСТ] проверка', createdAt: '2026-09-28T10:00:00Z' }],
        status: { rejected: false },
      }),
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flexi_delete_note', () => {
  it('refuses to delete anything without note_id or match', async () => {
    const res = await flexi_delete_note.handler({
      company_id: 'A12',
      event_key: 'rosupack2026',
    });
    expect(res.error).toMatch(/вслепую/);
    expect(calls).toHaveLength(0);
  });

  it('requires a company', async () => {
    const res = await flexi_delete_note.handler({ match: '[ТЕСТ]', event_key: 'rosupack2026' });
    expect(res.error).toMatch(/company_id или company_name/);
    expect(calls).toHaveLength(0);
  });

  it('sends DELETE with match and reports what is left', async () => {
    const res = await flexi_delete_note.handler({
      company_id: 'A12',
      match: '[ТЕСТ]',
      event_key: 'rosupack2026',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/api/site-predeal-notes');
    expect(calls[0].url).toContain('eventKey=rosupack2026');
    expect(calls[0].url).toContain('companyId=A12');
    expect(calls[0].url).toContain('match=%5B%D0%A2%D0%95%D0%A1%D0%A2%5D');
    expect(res.deleted).toBe(1);
    expect(res.remaining_notes).toBe(1);
    expect(res.has_deal).toBe(true);
  });

  it('sends messageId when a concrete note id is given', async () => {
    await flexi_delete_note.handler({
      company_id: 'A12',
      note_id: 'site-note-9',
      event_key: 'rosupack2026',
    });
    expect(calls[0].url).toContain('messageId=site-note-9');
    expect(calls[0].url).not.toContain('match=');
  });

  it('surfaces an API error instead of pretending success', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: 'boom' }),
    }));
    const res = await flexi_delete_note.handler({ company_id: 'A12', match: '[ТЕСТ]', event_key: 'rosupack2026' });
    expect(res.error).toMatch(/boom/);
  });
});

describe('flexi_add_note', () => {
  it('returns the new note id so it can be cleaned up right away', async () => {
    const res = await flexi_add_note.handler({
      company_name: 'Тестовая Компания',
      note_text: '[ТЕСТ] проверка карточки',
      event_key: 'rosupack2026',
    });
    expect(res.ok).toBe(true);
    expect(res.note_id).toBe('site-note-1');
  });
});
