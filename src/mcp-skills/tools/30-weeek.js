'use strict';

// Weeek CRM skill
// Weeek.net REST API — permanent Bearer token (no session expiry).
// Token stored in <AGENT_TOKENS_DIR>/{USER_ID}/weeek — read/written through the
// credential store (legacy plaintext transparent, v2 envelope decrypted).
// To get token: Weeek → Settings → API → Generate token.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { tokensRoot } = require('../../data-paths');
// Credential store (trained-assist-agent#1939): legacy plaintext passes through,
// an encrypted `weeek` / `weeek-session` file is decrypted — a raw readFileSync
// would hand back base64 garbage once CRED_ENCRYPTION_KEY is provisioned.
const { readCredentialFile, writeCredentialFile } = require('../../credential-store');

const USER_ID = process.env.USER_ID || '';
const WEEEK_BASE = 'https://api.weeek.net/public/v1';

// ── Token storage ─────────────────────────────────────────────────────────────

function profileDir(userId) {
  return path.join(tokensRoot(), String(userId || USER_ID));
}

function tokenPath(userId) {
  return path.join(profileDir(userId), 'weeek');
}

function sessionPath(userId) {
  return path.join(profileDir(userId), 'weeek-session');
}

function readToken(userId) {
  const file = tokenPath(userId);
  if (!fs.existsSync(file)) return null;
  // Encrypted file without CRED_ENCRYPTION_KEY (or an unreadable one): degrade
  // to "no token" loudly — isReady() runs this on every tool listing, so it must
  // never throw, and it must never return the base64 stub.
  try { return readCredentialFile(file).trim() || null; }
  catch (e) { console.warn('[weeek] cannot read the token %s: %s', file, e.message); return null; }
}

function writeToken(userId, token) {
  // Encrypted when CRED_ENCRYPTION_KEY is set, plaintext with a warning when not.
  writeCredentialFile(tokenPath(userId), token.trim());
}

// ── Reference schema ─────────────────────────────────────────────────────────
//
// Решение владельца (sales-skill#19, 03.10.2026), по аналогии с рекрутингом
// (`CANDIDATE_STATUSES` в trained-assist-hh-skill): **схема** — какие бывают
// роли — живёт в коде и валидируется с `throw`. **Привязка** роли к ID опции
// конкретного Weeek-workspace — в профиле, потому что ID у каждого workspace
// свои. Полный справочник Weeek здесь не дублируется: он приходит с API
// (`weeek_list_funnels` / `weeek_list_statuses`).

const FUNNEL_ROLES = ['Сколково', 'Партнеры'];

const STATUS_ROLES = [
  'Лид', 'Сообщение для ЛПР отправлено', 'Ждем фидбэк от ЛПР',
  'Планируем звонок/встречу', 'Назначен звонок/встреча', 'Проработка проекта',
  'Принимают решение', 'Направлено КП / договор', 'Контрактование',
  'Оплата аванса', 'Выиграно', 'Пауза', 'Не отвечают', 'Ожидание', 'Проиграно'
];

// Источники сделки. Раньше это были 21 константа `WEEEK_DEAL_SOURCE_OPTION_ID`
// в wrangler.toml бота — то есть данные, лежавшие в коде и менявшиеся от
// выставки к выставке. Теперь схема здесь, привязка — в профиле.
const DEAL_SOURCE_ROLES = [
  'Aquaflame 2026', 'DairyTech 2026', 'Константин Собольков', 'Ирина Егорова',
  'Павел Иванов', 'Никита Дыбо', 'AIRVent 2026', 'ПродЭкспо 2026',
  'Денис Шинкарев', 'Андрей Черноусов', '@Siebelv3', 'Саша Ташкевич',
  'LingerieShow', 'Интерлакокраска', 'Agravia', 'Вебинар 21.05.2026',
  'HeliRussia 2026', 'Электро 2026', 'metobr-expo.ru', 'RosUpack 2026',
  'ReIndustry Expo 2026', 'ECOM Expo 2026'
];

const DEAL_TYPE_ROLES = ['direct', 'partner'];
const DEAL_TYPE_LABELS = { direct: 'Прямые продажи', partner: 'Партнеры' };

// ── Сопоставление названий ─────────────────────────────────────────────────────
//
// Точное совпадение оказалось хрупким на реальных данных: в Weeek воронка
// называется «Cколково» с ЛАТИНСКОЙ C (в кириллице она неотличима глазом) и
// «Парнтеры» — с опечаткой. Оба варианта молча не матчились, и привязка
// оставалась пустой.
//
// Поэтому: нормализуем омоглифы и пробелы перед сравнением, а если роль не
// нашлась — отдаём ближайшее найденное название как ПОДСКАЗКУ, но не binds
// сами: догадываться за оператора нельзя, привязка влияет на реальные сделки.

// Латинские буквы, неотличимые от кириллических.
const HOMOGLYPHS = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О',
  P: 'Р', T: 'Т', X: 'Х', Y: 'У', a: 'а', c: 'с', e: 'е', o: 'о',
  p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т',
};

function normalizeRoleName(value) {
  return String(value ?? '')
    .replace(/[ABCDEHKMOPTXYacekoprtxy]/g, (ch) => HOMOGLYPHS[ch] || ch)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Расстояние Левенштейна — только чтобы предложить подсказку, не для решения. */
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Ближайшее название среди доступных, если оно правдоподобно близко. */
function suggestRoleName(role, available) {
  const target = normalizeRoleName(role);
  let best = null, bestScore = Infinity;
  for (const name of available) {
    const d = editDistance(target, normalizeRoleName(name));
    if (d < bestScore) { bestScore = d; best = name; }
  }
  // Порог = не больше половины длины роли: иначе подсказка шумнее, чем полезна.
  const threshold = Math.max(2, Math.floor(target.length / 2));
  return bestScore <= threshold ? { name: best, distance: bestScore } : null;
}

const REF_GROUPS = ['funnels', 'statuses', 'deal_sources', 'deal_types'];

function refsPath(userId) {
  return path.join(profileDir(userId), 'weeek-refs.json');
}

function readRefs(userId) {
  const file = refsPath(userId);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(readCredentialFile(file)) || {}; }
  catch (e) { console.warn('[weeek] cannot read refs %s: %s', file, e.message); return {}; }
}

function writeRefs(userId, refs) {
  writeCredentialFile(refsPath(userId), JSON.stringify(refs, null, 2));
}

function cleanRole(value) {
  return String(value ?? '').trim();
}

/** Типизированная ошибка: роль есть в схеме, но не привязана к ID в профиле. */
function requireRef(refs, group, role) {
  const value = cleanRole(role);
  if (!value) throw new Error(`weeek_set_refs: пустая роль в группе "${group}"`);
  const bound = refs?.[group]?.[value];
  if (!bound) {
    throw new Error(
      `weeek_set_refs: роль "${value}" из группы "${group}" не привязана к ID Weeek. ` +
      `Вызови weeek_set_refs${refs?.[group] ? '' : ' (файл привязок отсутствует)'} и проверь, ` +
      `что в справочнике Weeek есть опция с таким названием.`
    );
  }
  return bound;
}

function roleIsKnown(group, role) {
  const value = cleanRole(role);
  const known = {
    funnels: FUNNEL_ROLES,
    statuses: STATUS_ROLES,
    deal_sources: DEAL_SOURCE_ROLES,
    deal_types: DEAL_TYPE_ROLES,
  }[group];
  if (!known) throw new Error(`weeek_set_refs: неизвестная группа "${group}" (ожидается одна из: ${REF_GROUPS.join(', ')})`);
  return known.includes(value);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function weeekFetch(path, { method = 'GET', body, token } = {}) {
  const url = `${WEEEK_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Weeek API ${res.status}: ${data?.message || text.slice(0, 200)}`);
  }
  return data;
}

async function weeekCall(apiPath, opts, userId) {
  const token = readToken(userId);
  if (!token) throw new Error('Weeek token not set. Call weeek_set_token first.');
  return weeekFetch(apiPath, { ...opts, token });
}

const WEEEK_PRIVATE_BASE = 'https://api.weeek.net';

function readSession(userId) {
  const file = sessionPath(userId);
  if (!fs.existsSync(file)) return null;
  try { return readCredentialFile(file).trim() || null; }
  catch (e) { console.warn('[weeek] cannot read the session %s: %s', file, e.message); return null; }
}

function parseWorkspaceId(cookieStr) {
  const m = cookieStr.match(/workspace_id=([^;]+)/);
  return m ? m[1].trim() : null;
}

async function doPrivateFetch(apiPath, { method = 'GET', body, cookie } = {}) {
  const url = `${WEEEK_PRIVATE_BASE}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://app.weeek.net',
      Referer: 'https://app.weeek.net/',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function refreshWeeekSession(userId) {
  const refreshScript = path.join(os.homedir(), 'trained-assist-agent', 'scripts', 'refresh-weeek-session.js');
  const profile = userId || USER_ID || 'flexi';
  const profiles = profile === 'flexi' ? 'flexi' : `${profile},flexi`;
  execSync(`node "${refreshScript}"`, {
    timeout: 90000,
    env: { ...process.env, WEEEK_SESSION_PROFILES: profiles },
    stdio: 'pipe',
  });
  return readSession(userId);
}

async function weeekPrivateFetch(apiPath, { method = 'GET', body, cookie, userId } = {}) {
  let result = await doPrivateFetch(apiPath, { method, body, cookie });
  if ((result.status === 401 || result.status === 403) && userId !== false) {
    // Auto-refresh: run headless Playwright login, get fresh cookie, retry once
    console.log('[weeek/L2] Session expired (%d), auto-refreshing…', result.status);
    try {
      const freshCookie = refreshWeeekSession(userId);
      if (freshCookie) {
        result = await doPrivateFetch(apiPath, { method, body, cookie: freshCookie });
      }
    } catch (e) {
      console.error('[weeek/L2] Auto-refresh failed:', e.message.slice(0, 150));
    }
  }
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      throw new Error('Weeek L2 сессия устарела и авторефреш не удался. Обновите вручную через /connect/weeek.');
    }
    throw new Error(`Weeek Private API ${result.status}: ${result.data?.message || JSON.stringify(result.data).slice(0, 200)}`);
  }
  return result.data;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

// ── Контракт обязательных полей сделки (sales-skill#19, G7) ───────────────────
//
// Визард гарантировал заполнение полей: это был конечный автомат, который вёл
// пользователя по кнопкам и не давал пропустить обязательное. Агент — нет: он
// сам решает, какой тул вызвать, и может позвать create_deal с половиной полей.
//
// Поэтому контракт явный, а неполные данные дают типизированную ошибку, а не
// сделку с дырявыми полями: менеджер не видит, что писал посетитель, и не
// понимает, почему в сделке нет ИНН.
//
// Набор повторяет то, что бот считал обязательным (WEEEK_REQUIRE_* в его
// wrangler.toml): компания, комментарий, контакт. Плюс источник и тип — без них
// сделку не разобрать в воронке.
const DEAL_REQUIRED_FIELDS = [
  { key: 'status_id', label: 'статус (стадия воронки)' },
  { key: 'title', label: 'название компании' },
  { key: 'source', label: 'источник сделки' },
  { key: 'deal_type', label: 'тип сделки (direct | partner)' },
  { key: 'company_inn', label: 'ИНН компании' },
  { key: 'deal_comment', label: 'комментарий к сделке' },
  { key: 'contact_name', label: 'контактное лицо' },
];

const DEAL_TYPES = ['direct', 'partner'];

// Кастомные поля сделки, которые мы заполняем. Имена — схема; ID — привязка в
// профиле (weeek_set_refs читает /crm/custom-fields). Без привязки значение
// молча не легло бы в сделку: Weeek ждёт customFields по ID поля, а не по имени.
//
// input — имя, под которым значение приходит от вызывающего; key — роль в
// профиле. Они различаются у ИНН: контракт обязательных полей зовёт его
// company_inn (так его называют данные выставки и create_deal), а роль в
// профиле — inn. Без input значение молча терялось: поле было обязательным в
// валидации и не попадало ни в customFields, ни в блок «поля без привязки».
const DEAL_FIELD_ROLES = [
  { key: 'source', label: 'Источник сделки' },
  { key: 'deal_type', label: 'Тип сделки' },
  { key: 'stand', label: 'Стенд' },
  { key: 'hall', label: 'Зал' },
  { key: 'inn', label: 'ИНН', input: 'company_inn' },
  { key: 'deal_comment', label: 'Комментарий' },
  { key: 'contact_name', label: 'Контактное лицо' },
  { key: 'tg_chat_id', label: 'Telegram-чат' },
  { key: 'primary_communication_channel', label: 'Канал связи' },
];

/**
 * Проверяет обязательные поля до создания сделки.
 * → { ok: true } | { ok: false, code, missing, error }
 */
function validateDealInput(input) {
  const src = input || {};
  const missing = DEAL_REQUIRED_FIELDS.filter(f => {
    const v = src[f.key];
    return v == null || String(v).trim() === '';
  });
  if (missing.length) {
    return {
      ok: false,
      code: 'DEAL_MISSING_REQUIRED_FIELDS',
      missing: missing.map(f => f.key),
      error:
        `Нельзя создать сделку: не заполнены обязательные поля: ${missing.map(f => f.label).join(', ')}. ` +
        'Заполни их и повтори — сделка с дырявыми полями хуже, чем отсутствие сделки.',
    };
  }
  const type = String(src.deal_type).trim().toLowerCase();
  if (!DEAL_TYPES.includes(type)) {
    return {
      ok: false,
      code: 'DEAL_INVALID_TYPE',
      missing: ['deal_type'],
      error: `Тип сделки «${src.deal_type}» не из схемы. Ожидается одно из: ${DEAL_TYPES.join(', ')}.`,
    };
  }
  return { ok: true };
}


module.exports = {
  // Storage helpers, exported for tests — the registry only reads
  // `.tools`/`.isReady`/`.setupTools`, so extra exports here are inert.
  tokenPath, sessionPath, readToken, writeToken, readSession,
  // Контракт обязательных полей (G7) — тестируется напрямую.
  validateDealInput, DEAL_REQUIRED_FIELDS, DEAL_TYPES, DEAL_FIELD_ROLES,
  normalizeRoleName, suggestRoleName,
  isReady: () => !!readToken(USER_ID),
  setupTools: ['weeek_status', 'weeek_set_token'],

  tools: {

    weeek_set_token: {
      description: 'Save Weeek API token for the current user. Get token: Weeek Settings → Integrations → API.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Weeek API Bearer token' },
          user_id: { type: 'string', description: 'User ID (optional, defaults to session user)' },
        },
        required: ['token'],
      },
      handler: async ({ token, user_id }) => {
        const uid = user_id || USER_ID;
        if (!uid) return { error: 'No user_id' };
        writeToken(uid, token);
        // Verify token works
        try {
          const data = await weeekFetch('/crm/funnels', { token });
          const count = data.funnels?.length ?? '?';
          return { ok: true, message: `Token saved. Found ${count} funnels.` };
        } catch (e) {
          return { ok: true, warning: `Token saved but verification failed: ${e.message}` };
        }
      },
    },

    weeek_status: {
      description: 'Check Weeek API connection status. Returns whether token is set and valid.',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        const token = readToken(uid);
        if (!token) return { connected: false, message: 'No token. Call weeek_set_token.' };
        try {
          const data = await weeekFetch('/crm/funnels', { token });
          return { connected: true, funnels: data.funnels?.length ?? 0 };
        } catch (e) {
          return { connected: false, error: e.message };
        }
      },
    },

    weeek_list_funnels: {
      description: 'List all CRM funnels (pipelines) in Weeek.',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall('/crm/funnels', {}, uid);
        return { funnels: data.funnels ?? [] };
      },
    },

    // Привязка ролей к ID. Без неё агент не может ни создать сделку в нужной
    // воронке, ни поставить источник: ID опций у каждого Weeek-workspace свои,
    // а в коде скилла живёт только схема.
    weeek_set_refs: {
      description:
        'Прочитать справочник Weeek (воронки, статусы) и сохранить привязку наших ролей к ID опций ' +
        'в ~/agent-tokens/<profile>/weeek-refs.json. Вызывать после weeek_set_token и после любых ' +
        'изменений воронок/статусов в Weeek. Непривязанные роли остаются в отчёте — их надо создать ' +
        'в Weeek или выбрать другое название.',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        if (!uid) return { error: 'No user_id' };
        const token = readToken(uid);
        if (!token) return { error: 'Weeek token not set. Call weeek_set_token first.' };

        const refs = readRefs(uid);
        const report = { funnels: [], statuses: [], unmatched: [] };

        // Воронки: GET /crm/funnels → [{ id, name }]
        const funnelsData = await weeekFetch('/crm/funnels', { token });
        // Ключ — нормализованное имя, поэтому «Cколково» с латинской C и
        // «Сколково» с кириллической схлопываются в одну запись.
        const funnelByName = new Map();
        for (const f of funnelsData.funnels ?? []) funnelByName.set(normalizeRoleName(f.name), f.id);
        const funnelNames = (funnelsData.funnels ?? []).map(f => String(f.name ?? '').trim());
        refs.funnels = { ...(refs.funnels || {}) };
        for (const role of FUNNEL_ROLES) {
          const id = funnelByName.get(normalizeRoleName(role));
          if (id) { refs.funnels[role] = id; report.funnels.push({ role, id }); }
          else report.unmatched.push({ group: 'funnels', role, suggestion: suggestRoleName(role, funnelNames) });
        }

        // Статусы: у каждой воронки свой набор, поэтому идём по привязанным воронкам.
        refs.statuses = { ...(refs.statuses || {}) };
        for (const funnelId of Object.values(refs.funnels)) {
          const data = await weeekFetch(`/crm/funnels/${encodeURIComponent(funnelId)}/statuses`, { token });
          const byName = new Map();
          const names = [];
          for (const s of data.statuses ?? []) {
            names.push(String(s.name ?? '').trim());
            byName.set(normalizeRoleName(s.name), s.id);
          }
          for (const role of STATUS_ROLES) {
            const id = byName.get(normalizeRoleName(role));
            if (id) { refs.statuses[role] = id; report.statuses.push({ role, id }); }
            else report.unmatched.push({ group: 'statuses', role, suggestion: suggestRoleName(role, names) });
          }
        }

        // Кастомные поля: GET /crm/custom-fields → [{ id, name, type, options }].
        // Имена — схема, ID — привязка. В воркспейсе может не быть поля, которое
        // бот держал константой: тогда оно честно попадает в unmatched с подсказкой,
        // а не создаёт сделку с несуществующим полем.
        refs.deal_fields = refs.deal_fields || {};
        try {
          const cf = await weeekFetch('/crm/custom-fields', { token });
          const byName = new Map();
          const names = [];
          for (const f of cf.data ?? []) {
            names.push(String(f.name ?? '').trim());
            byName.set(normalizeRoleName(f.name), f.id);
          }
          for (const role of DEAL_FIELD_ROLES) {
            const id = byName.get(normalizeRoleName(role.key));
            if (id) { refs.deal_fields[role.key] = id; report.deal_fields.push({ role: role.key, id }); }
            else report.unmatched.push({ group: 'deal_fields', role: role.key, suggestion: suggestRoleName(role.key, names) });
          }
        } catch (e) {
          report.unmatched.push({ group: 'deal_fields', error: e.message });
        }

        // Источники и типы сделки — опции кастомных полей. Схема объявлена, но
        // привязку они получают отдельно: справочник опций кастомных полей через
        // публичный API не отдаётся, а дублировать 21 ID из wrangler.toml бота в
        // код скилла решено не было (это данные, а не код).
        refs.deal_sources = refs.deal_sources || {};
        refs.deal_types = refs.deal_types || {};
        for (const role of DEAL_SOURCE_ROLES) if (!refs.deal_sources[role]) report.unmatched.push({ group: 'deal_sources', role });
        for (const role of DEAL_TYPE_ROLES) if (!refs.deal_types[role]) report.unmatched.push({ group: 'deal_types', role });

        writeRefs(uid, refs);
        return {
          ok: true,
          path: refsPath(uid),
          bound: {
            funnels: Object.keys(refs.funnels).length,
            statuses: Object.keys(refs.statuses).length,
            deal_fields: Object.keys(refs.deal_fields).length,
            deal_sources: Object.keys(refs.deal_sources).length,
            deal_types: Object.keys(refs.deal_types).length,
          },
          matched: report,
          refs,
        };
      },
    },

    weeek_get_refs: {
      description:
        'Прочитать привязку ролей к ID Weeek из профиля. Возвращает всё, что привязано, ' +
        'и отдельно — роли из схемы, которые ещё не привязаны (их нельзя использовать: ' +
        'requireRef бросит типизированную ошибку).',
      inputSchema: { type: 'object', properties: { user_id: { type: 'string' } } },
      handler: async ({ user_id } = {}) => {
        const uid = user_id || USER_ID;
        if (!uid) return { error: 'No user_id' };
        const refs = readRefs(uid);
        const unbound = {};
        for (const group of REF_GROUPS) {
          const known = { funnels: FUNNEL_ROLES, statuses: STATUS_ROLES, deal_sources: DEAL_SOURCE_ROLES, deal_types: DEAL_TYPE_ROLES }[group];
          unbound[group] = known.filter(role => !refs?.[group]?.[role]);
        }
        return { ok: true, path: refsPath(uid), refs, unbound, deal_type_labels: DEAL_TYPE_LABELS };
      },
    },

    weeek_list_statuses: {
      description: 'List statuses (stages/columns) within a funnel.',
      inputSchema: {
        type: 'object',
        properties: {
          funnel_id: { type: 'string', description: 'Funnel ID from weeek_list_funnels' },
          user_id: { type: 'string' },
        },
        required: ['funnel_id'],
      },
      handler: async ({ funnel_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/funnels/${encodeURIComponent(funnel_id)}/statuses`, {}, uid);
        return { statuses: data.statuses ?? [] };
      },
    },

    weeek_list_deals: {
      description: 'List deals in a CRM status/stage. Supports pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          status_id: { type: 'string', description: 'Status/stage ID from weeek_list_statuses' },
          limit: { type: 'number', description: 'Max deals to return (default 20, max 100)' },
          offset: { type: 'number', description: 'Pagination offset' },
          last_updated: { type: 'string', description: 'Filter deals updated after this ISO date' },
          user_id: { type: 'string' },
        },
        required: ['status_id'],
      },
      handler: async ({ status_id, limit = 20, offset = 0, last_updated, user_id }) => {
        const uid = user_id || USER_ID;
        const params = new URLSearchParams({
          limit: String(Math.min(limit, 100)),
          offset: String(offset),
          sort: '-updatedAt',
        });
        if (last_updated) params.append('lastUpdated', last_updated);
        const data = await weeekCall(`/crm/statuses/${encodeURIComponent(status_id)}/deals?${params}`, {}, uid);
        return { deals: data.deals ?? [], hasMore: data.hasMoreDeals === true };
      },
    },

    weeek_get_deal: {
      description: 'Get a single deal by ID with all its fields.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, {}, uid);
        return data.deal ?? data;
      },
    },

    weeek_create_deal: {
      description: 'Create a new deal in a CRM status/stage.',
      inputSchema: {
        type: 'object',
        properties: {
          status_id: { type: 'string', description: 'Status/stage ID to create deal in' },
          title: { type: 'string', description: 'Deal title/name' },
          description: { type: 'string', description: 'Deal notes/description (plain text or HTML)' },
          amount: { type: 'number', description: 'Deal amount/price' },
          contact_id: { type: 'string', description: 'Contact ID to link (optional)' },
          source: { type: 'string', description: 'Источник сделки (роль из схемы, напр. «RosUpack 2026»)' },
          deal_type: { type: 'string', description: 'Тип сделки: direct | partner' },
          company_inn: { type: 'string', description: 'ИНН компании' },
          deal_comment: { type: 'string', description: 'Комментарий к сделке' },
          contact_name: { type: 'string', description: 'Контактное лицо' },
          custom_fields: { type: 'object', description: 'Custom field values as key-value pairs' },
          user_id: { type: 'string' },
        },
        required: ['status_id', 'title'],
      },
      handler: async (input) => {
        // Контракт обязательных полей (G7): неполные данные — типизированная
        // ошибка, а не сделка с дырявыми полями.
        const check = validateDealInput(input);
        if (!check.ok) return check;

        const { status_id, title, description, amount, contact_id, custom_fields, user_id,
                source, deal_type, company_inn, deal_comment, contact_name } = input;
        const uid = user_id || USER_ID;

        // Комментарий — в description: это поле есть всегда, в отличие от кастомных.
        const body = {
          title,
          ...((description ?? deal_comment) ? { description: description ?? deal_comment } : {}),
          ...(amount !== undefined && { price: amount }),
          ...(contact_id && { contactId: contact_id }),
        };

        // Кастомные поля — по ID, а не по имени: Weeek иначе молча их теряет, и
        // сделка выходит пустой оболочкой. ID берём из привязки в профиле.
        const refs = readRefs(uid);
        const fields = { ...(custom_fields || {}) };
        const unmapped = [];
        for (const role of DEAL_FIELD_ROLES) {
          const raw = role.input ? input[role.input] : input[role.key];
          const value = role.input && raw == null ? input[role.key] : raw;
          if (value == null || String(value).trim() === '') continue;
          const fieldId = refs?.deal_fields?.[role.key];
          if (fieldId) fields[fieldId] = value;
          else unmapped.push({ key: role.key, label: role.label, value });
        }
        if (Object.keys(fields).length) body.customFields = fields;

        // Поля, которых в воркспейсе нет, не выбрасываем: складываем в description
        // читаемым блоком. Иначе сделка теряла бы данные только потому, что
        // оператор ещё не создал кастомное поле в Weeek.
        if (unmapped.length) {
          const block = unmapped.map(f => `${f.label}: ${f.value}`).join('\n');
          body.description = body.description ? `${body.description}\n\n${block}` : block;
        }

        const data = await weeekCall(`/crm/statuses/${encodeURIComponent(status_id)}/deals`, { method: 'POST', body }, uid);
        return data.deal ?? data;
      },
    },

    weeek_update_deal: {
      description: 'Update an existing deal (title, amount, status, custom fields).',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to update' },
          title: { type: 'string' },
          amount: { type: 'number' },
          status_id: { type: 'string', description: 'Move to this status/stage' },
          custom_fields: { type: 'object', description: 'Custom field values to update' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, title, amount, status_id, custom_fields, user_id }) => {
        const uid = user_id || USER_ID;
        const body = {};
        if (title !== undefined) body.title = title;
        if (amount !== undefined) body.price = amount;
        if (status_id !== undefined) body.statusId = status_id;
        if (custom_fields !== undefined) body.customFields = custom_fields;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, { method: 'PATCH', body }, uid);
        return data.deal ?? data;
      },
    },

    weeek_delete_deal: {
      description: 'Delete a deal permanently.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['deal_id'],
      },
      handler: async ({ deal_id, user_id }) => {
        const uid = user_id || USER_ID;
        await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}`, { method: 'DELETE' }, uid);
        return { ok: true, deleted: deal_id };
      },
    },

    weeek_list_contacts: {
      description: 'List CRM contacts with optional search by name or phone/email.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (name, phone, email)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
          offset: { type: 'number' },
          user_id: { type: 'string' },
        },
      },
      handler: async ({ query, limit = 20, offset = 0, user_id } = {}) => {
        const uid = user_id || USER_ID;
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (query) params.set('query', query);
        const data = await weeekCall(`/crm/contacts?${params}`, {}, uid);
        const contacts = (data.contacts ?? []).map(c => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' '),
          phone: c.phones?.[0]?.phone ?? null,
          email: c.emails?.[0]?.email ?? null,
          company: c.company ?? null,
          createdAt: c.createdAt,
        }));
        return { contacts, hasMore: data.hasMoreContacts === true };
      },
    },

    weeek_get_contact: {
      description: 'Get a single contact by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['contact_id'],
      },
      handler: async ({ contact_id, user_id }) => {
        const uid = user_id || USER_ID;
        const data = await weeekCall(`/crm/contacts/${encodeURIComponent(contact_id)}`, {}, uid);
        return data.contact ?? data;
      },
    },

    weeek_create_contact: {
      description: 'Create a new CRM contact. API uses firstName/lastName split and phones/emails as string arrays.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full contact name (will be split into firstName/lastName)' },
          phone: { type: 'string', description: 'Phone number (e.g. "+79001234567")' },
          email: { type: 'string', description: 'Email address' },
          company: { type: 'string', description: 'Company/organization name' },
          user_id: { type: 'string' },
        },
        required: ['name'],
      },
      handler: async ({ name, phone, email, company, user_id }) => {
        const uid = user_id || USER_ID;
        // Weeek API requires firstName (required) and optional lastName
        const parts = String(name).trim().split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ') || undefined;
        const body = {
          firstName,
          ...(lastName && { lastName }),
          ...(phone && { phones: [String(phone)] }),
          ...(email && { emails: [String(email)] }),
          ...(company && { company }),
        };
        const data = await weeekCall('/crm/contacts', { method: 'POST', body }, uid);
        const c = data.contact ?? data;
        // Normalize returned contact for easier reading
        if (c && c.firstName) {
          c.name = [c.firstName, c.lastName].filter(Boolean).join(' ');
          c.phone = c.phones?.[0]?.phone ?? null;
          c.email = c.emails?.[0]?.email ?? null;
        }
        return c;
      },
    },

    weeek_update_contact: {
      description: 'Update an existing CRM contact.',
      inputSchema: {
        type: 'object',
        properties: {
          contact_id: { type: 'string' },
          name: { type: 'string', description: 'Full name (split into firstName/lastName)' },
          phone: { type: 'string' },
          email: { type: 'string' },
          company: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['contact_id'],
      },
      handler: async ({ contact_id, name, phone, email, company, user_id }) => {
        const uid = user_id || USER_ID;
        const body = {};
        if (name !== undefined) {
          const parts = String(name).trim().split(/\s+/);
          body.firstName = parts[0];
          if (parts.length > 1) body.lastName = parts.slice(1).join(' ');
        }
        if (phone !== undefined) body.phones = [String(phone)];
        if (email !== undefined) body.emails = [String(email)];
        if (company !== undefined) body.company = company;
        const data = await weeekCall(`/crm/contacts/${encodeURIComponent(contact_id)}`, { method: 'PATCH', body }, uid);
        return data.contact ?? data;
      },
    },

    weeek_add_task: {
      description: 'Add a task/action item to a deal. Use when user mentions a date ("на вторник", "завтра") or specific action to remember.',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to add task to' },
          title: { type: 'string', description: 'Task title (e.g. "Позвонить", "Встреча", "Отправить КП")' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (compute from relative: "завтра", "на вторник", etc.)' },
          user_id: { type: 'string' },
        },
        required: ['deal_id', 'title'],
      },
      handler: async ({ deal_id, title, due_date, user_id }) => {
        const uid = user_id || USER_ID;
        const body = { title };
        if (due_date) body.dueDate = due_date;
        const data = await weeekCall(`/crm/deals/${encodeURIComponent(deal_id)}/tasks`, { method: 'POST', body }, uid);
        return data.task ?? data;
      },
    },

    weeek_add_comment: {
      description: 'Add a comment to a CRM deal (requires L2 session — login+password configured via /connect/weeek).',
      inputSchema: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'Deal ID to comment on' },
          text: { type: 'string', description: 'Comment text (plain text, newlines allowed)' },
          workspace_id: { type: 'string', description: 'Workspace ID (auto-detected from session cookie if omitted)' },
          user_id: { type: 'string' },
        },
        required: ['deal_id', 'text'],
      },
      handler: async ({ deal_id, text, workspace_id, user_id }) => {
        const uid = user_id || USER_ID;
        const cookie = readSession(uid);
        if (!cookie) throw new Error('Weeek L2 сессия не настроена. Добавьте логин+пароль через /connect/weeek.');
        const wsId = workspace_id || parseWorkspaceId(cookie);
        if (!wsId) throw new Error('Не удалось определить workspace_id. Передайте его явно.');
        const content = {
          type: 'doc',
          content: String(text).split(/\r?\n/).map(line =>
            line ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
                 : { type: 'paragraph' }
          ),
        };
        const data = await weeekPrivateFetch(
          `/ws/${encodeURIComponent(wsId)}/crm/deals/${encodeURIComponent(deal_id)}/comments`,
          { method: 'POST', body: { parentId: null, content }, cookie }
        );
        return data.comment ?? data;
      },
    },
  },
};
