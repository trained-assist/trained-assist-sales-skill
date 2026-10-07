'use strict';

// Flexi Sales — exhibition notes + status via site-predeal-notes API
//
// Connects to the flexi-telegram-deal-bot Cloudflare Worker (/api/site-predeal-notes).
// Auth: none needed for server-to-server (no Origin header = allowed by CORS policy).
// Deals: delegate to 30-weeek.js weeek_create_deal.
//
// Context store:
//   flexi/active_exhibition → { event_key, name }

const fs   = require('fs');
const path = require('path');
const { isExpoEnabled, expoDataDir } = require('../expo-paths.js');
const { notesApiUrl, notesHealthUrl } = require('../notes-api.js');
// Идентичность компании и разбор deep-link живут в expo-ids.js — тем же
// контрактом пользуются генератор каталога и его проверка на сборке.
const { parseDeepLink } = require('../expo-ids.js');
const { readBinding, writeBinding, claimBinding, clearBinding, listBindings } = require('../expo-deals.js');
const { tokensRoot } = require('../../data-paths.js');
const { readCredentialFile } = require('../../credential-store.js');
// Контракт обязательных полей (G7) живёт в 30-weeek.js — рядом с create_deal.
const { validateDealInput } = require('./30-weeek.js');
// Shared event source contract for deal tools and validation.
const { EVENT_NAMES } = require('../../sales/exhibitions');

// Адрес API заметок — из notes-api.js, тем же, что подставляется в собираемый
// каталог. Раньше дефолт стоял здесь, а в шаблоне каталога был зашит другой
// воркер: инструменты и сайт писали заметки в разные места.
const notesApi = notesApiUrl();
const NOTES_API = notesApi;
const HEALTH_URL = notesHealthUrl();

const FETCH_TIMEOUT_MS = 8000;

// ── Context store (mirrors 03-context-store.js) ────────────────────────────────────

function contextPath(skill, key) {
  return path.join(process.cwd(), 'contexts', skill, `${key}.json`);
}

function readContext(skill, key) {
  try {
    const file = contextPath(skill, key);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeContext(skill, key, value) {
  const file = contextPath(skill, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clean(v) { return (v == null ? '' : String(v)).trim(); }

function activeEventKey() {
  const ctx = readContext('flexi', 'active_exhibition');
  return ctx?.value?.event_key || null;
}

function companyIdFromStand(stand) {
  const s = clean(stand).replace(/\s+/g, '').toLowerCase();
  return s || null;
}

function companyIdFromName(name) {
  return clean(name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9а-яёА-ЯЁ-]/g, '').slice(0, 40);
}

async function apiGet(params) {
  const url = new URL(NOTES_API);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(vi => url.searchParams.append(k, String(vi)));
    else url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = await res.json();
    return { httpStatus: res.status, ...json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function apiPost(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v != null && v !== '') form.set(k, String(v));
  }
  try {
    const res = await fetch(NOTES_API, { method: 'POST', body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = await res.json();
    return { httpStatus: res.status, ...json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function apiDelete(params) {
  const url = new URL(NOTES_API);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), { method: 'DELETE', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = await res.json();
    return { httpStatus: res.status, ...json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resolveEventKey(event_key) {
  return clean(event_key) || activeEventKey();
}

// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Сделка из карточки каталога (sales-skill#19, G9 + G10)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Привязка ролей к ID Weeek из профиля (weeek_set_refs). Без неё агент не может
 * ни создать сделку в нужной воронке, ни поставить источник — ID опций у каждого
 * workspace свои, и угадывать их нельзя.
 */
function readRefs(userId) {
  try {
    const file = path.join(tokensRoot(), String(userId || process.env.USER_ID), 'weeek-refs.json');
    return JSON.parse(readCredentialFile(file)) || {};
  } catch { return {}; }
}

function cleanRole(value) {
  return clean(value);
}

function requireRef(refs, group, role) {
  const name = cleanRole(role);
  if (!name) throw new Error(`weeek_set_refs: пустая роль в группе "${group}"`);
  const id = refs?.[group]?.[name];
  if (!id) {
    throw new Error(
      `Роль «${name}» (${group}) не привязана к ID Weeek. Вызови weeek_set_refs, затем повтори.`
    );
  }
  return id;
}

/** Текст карточки компании — то, что менеджер видит в описании сделки. */
function companyInfoText(c) {
  return [
    c.b ? String(c.b) : '',
    c.cat ? `Категории: ${c.cat}` : '',
    c.inn ? `ИНН: ${c.inn}` : '',
    c.ogrn ? `ОГРН: ${c.ogrn}` : '',
    c.okved ? `ОКВЭД: ${c.okved}` : '',
    c.rev != null ? `Выручка: ${c.rev} млн руб.${c.ry ? `, ${c.ry}` : ''}` : '',
    c.prof != null ? `Прибыль: ${c.prof} млн руб.${c.py ? `, ${c.py}` : ''}` : '',
    c.country ? `Страна: ${c.country}` : ''
  ].filter(Boolean).join('\n');
}

/** Заметки посетителя — обязаны доехать до сделки, а не остаться в prelead. */
function notesToText(notes) {
  if (!notes.length) return '';
  return notes.map((n, i) => {
    const head = n.kind === 'audio' ? `Аудиозаметка ${i + 1}` : `Заметка ${i + 1}`;
    const parts = [head];
    if (n.text) parts.push(n.text);
    if (n.transcript && n.transcript !== n.text) parts.push(`Расшифровка: ${n.transcript}`);
    if (n.at) parts.push(`от ${n.at}`);
    return parts.join(' — ');
  }).join('\n');
}

/**
 * Отметка «сделка создана» в API заметок — чтобы каталог показал бейдж.
 * Отдельная операция, а не часть создания сделки: сбой записи статуса не должен
 * ни отменять уже созданную сделку, ни провоцировать повторное создание.
 */
async function markDealOnSite({ eventKey, companyId, companyName, dealId, hall, stand }) {
  const data = await apiPost({
    eventKey, companyId, companyName, dealId, statusAction: 'deal',
    ...(hall ? { hall } : {}), ...(stand ? { stand } : {}),
  });
  if (!data.ok) {
    return { ok: false, error: data.error || `HTTP ${data.httpStatus}` };
  }
  return { ok: true, already_marked: Boolean(data.alreadyMarked), marked_at: data.markedAt || null };
}

module.exports = {
  isReady: isExpoEnabled,
  setupTools: [],
  tools: {

    flexi_status: {
      description:
        'Проверить текущую активную выставку и доступность API заметок. ' +
        'Вызывай в начале сессии.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const ctx = readContext('flexi', 'active_exhibition');
        const exh = ctx?.value || null;

        let apiOk = false;
        try {
          const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
          apiOk = res.ok;
        } catch {}

        return {
          api_url: NOTES_API,
          api_reachable: apiOk,
          active_exhibition: exh,
          hint: exh
            ? `Активна: ${exh.name || exh.event_key}. Можно добавлять заметки и работать со сделками.`
            : 'Выставка не выбрана. Вызови flexi_set_active_exhibition(event_key).',
        };
      },
    },

    flexi_set_active_exhibition: {
      description:
        'Выбрать, с какой выставкой работать — активная выставка. Сохраняется в context store, запоминается между сессиями.\n\n' +
        'Это выбор конкретной выставки, а НЕ включение режима. Чтобы включить сами инструменты выставок, используй expo_enable_skills.\n\n' +
        'Известные event_key: rosupack2026, stonefair2026, oborot2026, reindustry2026, ' +
        'interautomechanica2026, avtobusexpo2026, ipsa2026, cpmautumn2026, textilesalon2026, otdykhleisure2026',
      inputSchema: {
        type: 'object',
        required: ['event_key'],
        properties: {
          event_key: { type: 'string', description: 'Ключ выставки, напр. rosupack2026' },
          name: { type: 'string', description: 'Понятное название (если не стандартный event_key)' },
        },
      },
      handler: async ({ event_key, name }) => {
        const resolvedName = clean(name) || EVENT_NAMES[event_key] || event_key;
        const value = { event_key: clean(event_key), name: resolvedName };
        writeContext('flexi', 'active_exhibition', value);
        return { ok: true, active_exhibition: value };
      },
    },

    flexi_get_notes: {
      description:
        'Прочитать заметки и статус по компании на выставке.\n\n' +
        'company_id = номер стенда (A12, 14B08) — стабильный идентификатор. ' +
        'Если не знаешь id — используй company_name, id сгенерируется автоматически.',
      inputSchema: {
        type: 'object',
        properties: {
          company_id: { type: 'string', description: 'ID компании или номер стенда' },
          company_name: { type: 'string', description: 'Название компании (если нет company_id)' },
          event_key: { type: 'string', description: 'Ключ выставки (если не установлен через flexi_set_active_exhibition)' },
        },
      },
      handler: async ({ company_id, company_name, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };

        const cid = clean(company_id) || companyIdFromStand(company_name) || companyIdFromName(company_name || '');
        if (!cid) return { error: 'Нужен company_id или company_name' };

        const data = await apiGet({ eventKey, companyId: cid });
        if (!data.ok) return { error: `API вернул ошибку: ${data.error || data.httpStatus}` };

        const notes = (data.notes || []).map(n => ({ id: n.id || '', text: n.text || '', at: n.createdAt || '' }));
        return {
          event_key: eventKey,
          company_id: cid,
          has_deal: data.hasDeal || false,
          notes,
          note_count: notes.length,
          rejected: data.status?.rejected || false,
          rejection_reason: data.status?.rejectionReason || null,
        };
      },
    },

    flexi_get_notes_bulk: {
      description:
        'Получить заметки и статусы по нескольким компаниям сразу (до 50). ' +
        'Передавай список номеров стендов. Удобно для дайджеста — кто в работе, кто с заметками.',
      inputSchema: {
        type: 'object',
        required: ['company_ids'],
        properties: {
          company_ids: {
            type: 'array', items: { type: 'string' },
            description: 'Список company_id (номеров стендов)',
          },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_ids, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };
        if (!Array.isArray(company_ids) || !company_ids.length) return { error: 'company_ids должен быть непустым массивом' };

        const ids = company_ids.slice(0, 50).map(clean).filter(Boolean);
        const data = await apiGet({ eventKey, 'companyId[]': ids });
        if (!data.ok) return { error: `API error: ${data.error || data.httpStatus}` };

        const result = Object.entries(data.companies || {}).map(([cid, info]) => ({
          company_id: cid,
          has_notes: info.hasNotes,
          note_count: info.noteCount,
          last_note_at: info.lastNoteAt,
          has_deal: info.hasDeal,
          rejected: info.rejected,
        })).sort((a, b) => b.note_count - a.note_count);

        return {
          event_key: eventKey,
          total: result.length,
          with_notes: result.filter(c => c.note_count > 0).length,
          with_deal: result.filter(c => c.has_deal).length,
          rejected: result.filter(c => c.rejected).length,
          companies: result,
        };
      },
    },

    flexi_add_note: {
      description:
        'Добавить заметку по компании на выставке. ' +
        'Заметка сохраняется в системе прелидов (Cloudflare D1).\n\n' +
        'company_id = номер стенда (напр. B12 или 14A08) — один и тот же id = одна компания. ' +
        'Если стенда нет — используй название компании как id.\n\n' +
        'Weeek-сделку создай отдельно через weeek_create_deal — flexi_add_note только сохраняет заметку.',
      inputSchema: {
        type: 'object',
        required: ['company_name', 'note_text'],
        properties: {
          company_name: { type: 'string' },
          note_text: { type: 'string' },
          company_id: { type: 'string', description: 'Номер стенда или id из каталога. Если не указан — генерируется из stand или company_name.' },
          stand: { type: 'string', description: 'Номер стенда (для генерации id если company_id не указан)' },
          hall: { type: 'string', description: 'Павильон / зал' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, note_text, company_id, stand, hall, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };
        if (!clean(company_name)) return { error: 'company_name обязателен' };
        if (!clean(note_text)) return { error: 'note_text обязателен' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);

        const data = await apiPost({
          eventKey,
          companyId: cid,
          companyName: company_name,
          noteText: note_text,
          ...(stand ? { stand } : {}),
          ...(hall ? { hall } : {}),
        });

        if (!data.ok) return { error: `Ошибка API: ${data.error || JSON.stringify(data)}` };
        const notes = data.notes || [];
        return {
          ok: true,
          company_id: cid,
          company_name,
          event_key: eventKey,
          prelead_id: data.preleadId,
          note_id: notes.at(-1)?.id || '',
          note_count: notes.length,
        };
      },
    },

    flexi_delete_note: {
      description:
        'Удалить заметку с карточки компании на выставке (только заметки — отказ/сделка не удаляются).\n\n' +
        'Передай note_id (id из flexi_add_note/flexi_get_notes) ИЛИ match — подстроку текста заметки ' +
        '(напр. "[ТЕСТ]"). Указывать хотя бы одно ОБЯЗАТЕЛЬНО: без них ничего не удаляется.\n\n' +
        'Тестовые заметки помечай маркером "[ТЕСТ]" в начале текста и удаляй их этой командой — ' +
        'даже если удаление не пройдёт, на реальной карточке сразу видно, что это тест.',
      inputSchema: {
        type: 'object',
        properties: {
          company_id: { type: 'string', description: 'Номер стенда или id компании' },
          company_name: { type: 'string', description: 'Название компании (если нет company_id)' },
          note_id: { type: 'string', description: 'id конкретной заметки (из flexi_get_notes / flexi_add_note)' },
          match: { type: 'string', description: 'Удалить все заметки, содержащие подстроку (напр. "[ТЕСТ]")' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_id, company_name, note_id, match, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };

        const cid = clean(company_id) || companyIdFromStand(company_name) || companyIdFromName(company_name || '');
        if (!cid) return { error: 'Нужен company_id или company_name' };
        const noteId = clean(note_id);
        const matchText = clean(match);
        if (!noteId && !matchText) {
          return { error: 'Нужен note_id или match — вслепую заметки не удаляю' };
        }

        const data = await apiDelete({
          eventKey,
          companyId: cid,
          ...(noteId ? { messageId: noteId } : {}),
          ...(matchText ? { match: matchText } : {}),
        });

        if (!data.ok) return { error: `Ошибка API: ${data.error || JSON.stringify(data)}` };
        return {
          ok: true,
          company_id: cid,
          event_key: eventKey,
          deleted: data.deleted || 0,
          remaining_notes: (data.notes || []).length,
          has_deal: data.hasDeal || false,
          rejected: data.status?.rejected || false,
          message: data.deleted
            ? `Удалено заметок: ${data.deleted}. Осталось: ${(data.notes || []).length}.`
            : 'Ничего не удалено — подходящих заметок не найдено (это не ошибка).',
        };
      },
    },

    flexi_reject_company: {
      description:
        'Пометить компанию как отказ (не целевая, уже работаем с конкурентом, отказали). ' +
        'Статус виден в каталоге на сайте и в системе прелидов. Отменить — flexi_unreject_company.',
      inputSchema: {
        type: 'object',
        required: ['company_name'],
        properties: {
          company_name: { type: 'string' },
          company_id: { type: 'string', description: 'Номер стенда или id' },
          stand: { type: 'string' },
          hall: { type: 'string' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, company_id, stand, hall, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана.' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);
        const data = await apiPost({
          eventKey, companyId: cid, companyName: company_name, statusAction: 'reject',
          ...(stand ? { stand } : {}), ...(hall ? { hall } : {}),
        });

        if (!data.ok) return { error: `API error: ${data.error || JSON.stringify(data)}` };
        return { ok: true, company_id: cid, company_name, event_key: eventKey,
          rejected: data.status?.rejected, message: `${company_name} помечена как отказ` };
      },
    },

    flexi_unreject_company: {
      description: 'Снять статус отказа с компании — вернуть в работу.',
      inputSchema: {
        type: 'object',
        required: ['company_name'],
        properties: {
          company_name: { type: 'string' },
          company_id: { type: 'string' },
          stand: { type: 'string' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, company_id, stand, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана.' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);
        const data = await apiPost({ eventKey, companyId: cid, companyName: company_name, statusAction: 'unreject' });

        if (!data.ok) return { error: `API error: ${data.error || JSON.stringify(data)}` };
        return { ok: true, company_id: cid, company_name, message: `Отказ снят с ${company_name}` };
      },
    },

    flexi_deal_from_catalog: {
      description:
        'Создать сделку в Weeek из карточки каталога выставки.\n\n' +
        'Разбирает deep-link payload «<eventKey>_deal_<companyId>» — его формирует кнопка ' +
        '«Создать сделку» на сайте каталога — находит компанию в данных выставки, ' +
        'прикладывает заметки посетителя и создаёт сделку.\n\n' +
        'Заметки обязаны попасть в сделку, а не остаться в prelead: иначе менеджер ' +
        'не видит, что писал посетитель. Несколько компаний на одном стенде дают ' +
        'разные сделки — id берётся из данных, а не из стенда.',
      inputSchema: {
        type: 'object',
        properties: {
          payload: { type: 'string', description: 'Payload из deep-link: «<eventKey>_deal_<companyId>»' },
          event_key: { type: 'string', description: 'Ключ выставки (если не в payload)' },
          company_id: { type: 'string', description: 'ID компании (если не в payload)' },
          contact_name: {
            type: 'string',
            description: 'Контактное лицо. Обязательное поле сделки, а в данных выставки его нет — ' +
              'назови контакт и повтори вызов с тем же payload.',
          },
          company_inn: {
            type: 'string',
            description: 'ИНН компании, если в данных выставки его нет (найди через company_find_by_name / Checko).',
          },
        },
      },
      handler: async ({ payload, event_key, company_id, contact_name, company_inn }, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        // Profile identity comes from the trusted invocation context, never a
        // model-supplied tool argument.
        const uid = ctx?.userId || process.env.USER_ID || '';

        let eventKey = clean(event_key);
        let companyId = clean(company_id);
        if (payload) {
          const parsed = parseDeepLink(payload);
          if (!parsed) return { error: `Не понял payload «${payload}» — ожидается «<eventKey>_deal_<companyId>»` };
          if (!eventKey) eventKey = parsed.eventKey;
          if (!companyId) companyId = parsed.companyId;
        }
        eventKey = resolveEventKey(eventKey);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };
        if (!companyId) return { error: 'Нужен payload или company_id' };

        // Компания — из данных выставки, а не из стенда: на одном стенде может
        // быть несколько компаний, и каждая обязана дать свою сделку.
        const dir = expoDataDir(workDir, eventKey);
        const enrichedPath = path.join(dir, 'enriched.json');
        if (!fs.existsSync(enrichedPath)) {
          return { error: `Данные выставки не найдены: ${enrichedPath}`, hint: 'Собери каталог: expo_build_catalog' };
        }
        let companies;
        try {
          const raw = JSON.parse(fs.readFileSync(enrichedPath, 'utf8'));
          companies = Array.isArray(raw) ? raw : raw.companies || raw.results || [];
        } catch (e) { return { error: `Не удалось прочитать ${path.basename(enrichedPath)}: ${e.message}` }; }

        const company = companies.find(c => String(c.id) === String(companyId));
        if (!company) {
          return { error: `Компания ${companyId} не найдена в выставке ${eventKey} (в данных ${companies.length} компаний)` };
        }

        // Привязка карточка → сделка. hasDeal в API заметок защищает только от
        // следующего нажатия: два одновременных клика и обрыв связи после
        // успешного ответа Weeek он не ловит, а оба дают вторую сделку.
        const binding = readBinding(dir, eventKey, companyId);
        if (binding?.state === 'created' && binding.deal_id) {
          const mark = await markDealOnSite({ eventKey, companyId, companyName: company.n, dealId: binding.deal_id });
          return {
            ok: true,
            existing_deal: true,
            event_key: eventKey,
            company_id: companyId,
            company_name: company.n,
            deal_id: binding.deal_id,
            created_at: binding.created_at || null,
            site_status: mark.ok ? 'synced' : 'sync_failed',
            ...(mark.ok ? {} : { site_status_error: mark.error }),
            message: `Сделка уже создана (${binding.deal_id}) — вторую не создаю.`,
          };
        }
        if (binding?.state === 'creating') {
          return {
            ok: false,
            code: 'DEAL_CREATE_IN_PROGRESS',
            event_key: eventKey,
            company_id: companyId,
            company_name: company.n,
            started_at: binding.started_at || null,
            error: `По компании ${company.n} уже идёт создание сделки (начато ${binding.started_at || 'недавно'}). ` +
              'Повторный вызов не создаст вторую сделку и ждать не нужно.',
            hint: 'Проверь результат: flexi_sync_deal_status (покажет, записалась ли сделка) ' +
              'или weeek_list_deals по названию компании.',
          };
        }

        // Заметки и статус — с сайта каталога.
        const notesData = await apiGet({ eventKey, companyId });
        if (!notesData.ok) return { error: `API вернул ошибку: ${notesData.error || notesData.httpStatus}` };
        if (notesData.status?.rejected) {
          return { ok: false, rejected: true, company_name: company.n, message: `По компании ${company.n} уже отказ — сделку не создаю.` };
        }
        if (notesData.hasDeal) {
          return { ok: false, has_deal: true, company_name: company.n, message: `По компании ${company.n} уже есть сделка.` };
        }

        const notes = (notesData.notes || []).map(n => ({
          kind: n.kind || (n.audioUrl ? 'audio' : 'text'),
          text: n.text || '',
          transcript: n.transcript || '',
          at: n.at || n.createdAt || '',
        }));

        // Собираем ввод для сделки из того, что реально есть в данных.
        const sourceLabel = EVENT_NAMES[eventKey] || eventKey;
        const location = [company.hall, company.s ? `стенд ${company.s}` : ''].filter(Boolean).join(', ');
        const dealComment = [
          `Создано со страницы каталога ${sourceLabel}.`,
          location ? `Локация: ${location}` : '',
          company.t === 1 ? 'Целевой участник: да' : '',
          // Данные компании (выручка, директор, сайт, ОКВЭД) — иначе менеджер
          // получает сделку с названием и без выручки, ради которой пришёл.
          companyInfoText(company),
          notesToText(notes)
        ].filter(Boolean).join('\n');

        const dealInput = {
          status_id: requireRef(readRefs(uid), 'statuses', 'Лид'),
          title: company.n,
          source: sourceLabel,
          // Выставочный лид — прямая продажа; партнёрский тип бот ставил только
          // для партнёрской воронки, а она здесь не привязана.
          deal_type: 'direct',
          // ИНН в данных выставки есть не у всех (у 74 дублей в CPM его не было
          // вовсе) — агент может назвать его из другого источника.
          company_inn: clean(company_inn) || company.inn || '',
          deal_comment: dealComment,
          // Контактного лица в данных выставки нет — его должен назвать агент.
          contact_name: clean(contact_name),
          user_id: uid || undefined,
        };

        // Контракт обязательных полей (G7): неполные данные — не сделка с
        // дырявыми полями, а явный запрос недостающего. Агент дополняет и повторяет
        // ТОТ ЖЕ вызов с теми же payload/event_key/company_id плюс недостающими
        // полями — состояние собирается заново из данных выставки, поэтому
        // переживает и перезапуск сессии.
        const check = validateDealInput(dealInput);
        if (!check.ok) {
          const canSupply = missing => missing.filter(f => f !== 'status_id');
          return {
            ok: false,
            code: check.code,
            missing: check.missing,
            error: check.error,
            event_key: eventKey,
            company_id: companyId,
            company_name: company.n,
            stand: company.s || null,
            hall: company.hall || null,
            notes_attached: notes.length,
            // Что именно передать в следующем вызове — иначе агент не знает,
            // чем заполнить дыру, и повторяет вызов без него вечно.
            next_call: {
              payload: payload || null,
              event_key: eventKey,
              company_id: companyId,
              ...Object.fromEntries(canSupply(check.missing || []).map(f => [f, `<${f}>`])),
            },
            draft: {
              status_id: dealInput.status_id,
              title: dealInput.title,
              source: dealInput.source,
              deal_type: dealInput.deal_type,
              company_inn: dealInput.company_inn || null,
              deal_comment: dealComment,
            },
          };
        }

        const weeek = require('./30-weeek.js');
        // Помечаем «создаётся» ДО похода в Weeek: если процесс упадёт или
        // ответ потеряется, следующий вызов увидит незакрытую операцию и не
        // создаст вторую сделку.
        const opId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const claimed = claimBinding(dir, eventKey, companyId, {
          event_key: eventKey, company_id: companyId, company_name: company.n,
          state: 'creating', op_id: opId, started_at: new Date().toISOString(),
        });
        if (!claimed) {
          const raced = readBinding(dir, eventKey, companyId);
          if (raced?.state === 'created' && raced.deal_id) {
            const mark = await markDealOnSite({ eventKey, companyId,
              companyName: company.n, dealId: raced.deal_id });
            return { ok: true, existing_deal: true, event_key: eventKey,
              company_id: companyId, company_name: company.n, deal_id: raced.deal_id,
              created_at: raced.created_at || null,
              site_status: mark.ok ? 'synced' : 'sync_failed',
              ...(mark.ok ? {} : { site_status_error: mark.error }),
              message: `Сделка уже создана (${raced.deal_id}) — вторую не создаю.` };
          }
          return { ok: false, code: 'DEAL_CREATE_IN_PROGRESS', event_key: eventKey,
            company_id: companyId, company_name: company.n,
            started_at: raced?.started_at || null,
            error: `По компании ${company.n} уже создаётся сделка. Повторный вызов не создаст вторую.`,
            hint: 'Проверь flexi_sync_deal_status или найди сделку в Weeek перед повтором.' };
        }

        // Контракт результата (sales-skill#19, C4): внешний ok:true допустим
        // только при подтверждённом успехе. Различаем «Weeek отказал» и
        // «не знаем, создалась ли» — иначе неясный ответ приводит либо к
        // потерянной сделке, либо к дубликату при повторе.
        let result;
        try {
          result = await weeek.tools.weeek_create_deal.handler(dealInput, ctx);
        } catch (e) {
          const uncertain = e?.name === 'TimeoutError' || e?.name === 'AbortError';
          // При явном отказе операцию снимаем — повторять безопасно. При
          // неясном ответе оставляем: создание могло пройти, и повтор вслепую
          // дал бы вторую сделку.
          if (!uncertain) clearBinding(dir, eventKey, companyId);
          return {
            ok: false,
            code: uncertain ? 'DEAL_CREATE_OUTCOME_UNKNOWN' : 'DEAL_CREATE_FAILED',
            // created:false — повторять безопасно; unknown — сначала проверь Weeek.
            deal_created: uncertain ? 'unknown' : false,
            error: e.message,
            event_key: eventKey,
            company_id: companyId,
            company_name: company.n,
            ...(uncertain
              ? { hint: 'Ответ Weeek не дошёл. Повторный вызов НЕ создаст вторую сделку: следующий вызов вернёт DEAL_CREATE_IN_PROGRESS. Найди сделку в Weeek (weeek_list_deals по названию) и при необходимости закрой привязку.' }
              : { hint: 'Сделка не создана, можно исправить данные и повторить.' }),
          };
        }

        // Weeek умеет вернуть не исключение, а типизированный контракт G7 — тот
        // же, что проверяем выше. Не выдаём это за «сделка создана».
        if (result && result.ok === false) {
          clearBinding(dir, eventKey, companyId);
          return {
            ...result,
            deal_created: false,
            event_key: eventKey,
            company_id: companyId,
            company_name: company.n,
            next_call: { payload: payload || null, event_key: eventKey, company_id: companyId,
              ...Object.fromEntries((result.missing || []).filter(f => f !== 'status_id').map(f => [f, `<${f}>`])) },
          };
        }

        const dealId = result?.id || result?.dealId || result?.deal?.id || null;
        const createdAt = new Date().toISOString();
        writeBinding(dir, eventKey, companyId, {
          event_key: eventKey, company_id: companyId, company_name: company.n,
          state: 'created', op_id: opId, deal_id: dealId, created_at: createdAt,
        });

        // Каталог должен увидеть сделку. Сбой записи статуса — это отдельная
        // операция (flexi_sync_deal_status), а не повод создавать сделку снова.
        const mark = dealId
          ? await markDealOnSite({ eventKey, companyId, companyName: company.n, dealId })
          : { ok: false, error: 'Weeek не вернул id сделки — отметить статус на сайте нечем' };

        return {
          ok: true,
          event_key: eventKey,
          company_id: companyId,
          company_name: company.n,
          stand: company.s || null,
          hall: company.hall || null,
          notes_attached: notes.length,
          deal_id: dealId,
          deal: result,
          site_status: mark.ok ? 'synced' : 'sync_failed',
          ...(mark.ok ? {} : { site_status_error: mark.error, next_tool: 'flexi_sync_deal_status' }),
        };
      },
    },

    flexi_sync_deal_status: {
      description:
        'Дописать статус «сделка» на сайт каталога для уже созданных сделок.\n\n' +
        'Создание сделки и запись статуса на сайте — разные операции: сделка может быть создана, ' +
        'а статус не записан (сбой сети, воркер был недоступен). Этот тул повторяет ТОЛЬКО запись статуса ' +
        'и никогда не создаёт сделку заново.\n\n' +
        'Без company_id проходит по всем привязкам выставки — удобно после перезапуска, чтобы закрыть хвосты.',
      inputSchema: {
        type: 'object',
        properties: {
          event_key: { type: 'string', description: 'Ключ выставки (по умолчанию активная)' },
          company_id: { type: 'string', description: 'ID компании. Не указан — проходит по всем привязкам выставки' },
          force: { type: 'boolean', description: 'Перезаписать статус даже если он уже записан', default: false },
        },
      },
      handler: async ({ event_key, company_id, force = false }, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_active_exhibition.' };

        const dir = expoDataDir(workDir, eventKey);
        const wanted = clean(company_id);
        const bindings = wanted
          ? [readBinding(dir, eventKey, wanted)].filter(Boolean)
          : listBindings(dir);

        if (!bindings.length) {
          return {
            ok: true, synced: 0, event_key: eventKey,
            message: wanted
              ? `По компании ${wanted} нет созданной сделки — синхронизировать нечего.`
              : 'В выставке нет ни одной созданной сделки — синхронизировать нечего.',
          };
        }

        const done = [];
        const failed = [];
        for (const b of bindings) {
          if (b.state !== 'created' || !b.deal_id) {
            failed.push({ company_id: b.company_id, error: `состояние «${b.state}» — сделка не подтверждена` });
            continue;
          }
          if (b.site_marked_at && !force) {
            done.push({ company_id: b.company_id, deal_id: b.deal_id, status: 'уже отмечена' });
            continue;
          }
          const mark = await markDealOnSite({
            eventKey: b.event_key, companyId: b.company_id,
            companyName: b.company_name, dealId: b.deal_id,
          });
          if (mark.ok) {
            writeBinding(dir, b.event_key, b.company_id, {
              ...b, site_marked_at: mark.marked_at || new Date().toISOString(),
            });
            done.push({ company_id: b.company_id, deal_id: b.deal_id, status: mark.already_marked ? 'уже была' : 'отмечена' });
          } else {
            failed.push({ company_id: b.company_id, deal_id: b.deal_id, error: mark.error });
          }
        }

        return {
          ok: failed.length === 0,
          event_key: eventKey,
          synced: done.length,
          failed: failed.length,
          ...(done.length ? { done } : {}),
          ...(failed.length ? { failed } : {}),
          message: failed.length
            ? `Статус записан для ${done.length}, не записан для ${failed.length}. Повтори тул — сделки он не создаёт.`
            : `Статус «сделка» записан на сайте: ${done.length}.`,
        };
      },
    },

  },
};

// Тест-экспорт: чистые функции и два чтения, которые иначе не проверить без
// сети и без Weeek. В tools/list они не попадают — это не тулы.
module.exports._test = {
  parseDeepLink,
  companyInfoText,
  notesToText,
  requireRef,
  findCompanyForTest: (workDir, eventKey, companyId) => {
    const dir = expoDataDir(workDir, eventKey);
    const file = path.join(dir, 'enriched.json');
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const companies = Array.isArray(raw) ? raw : raw.companies || raw.results || [];
    return companies.find(c => String(c.id) === String(companyId)) || null;
  },
};
