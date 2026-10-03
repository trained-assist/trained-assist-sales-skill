'use strict';

// Deal field registry (issue #19, group G13) — the type layer under the deal tools.
//
// SHAPE, NOT VALUE. Every field is typed, so the agent gets a typed error when it
// sends something impossible instead of a Weeek 400 four layers down. This mirrors
// what trained-assist-hh-skill does for candidate status (hh-proactive-search.js:
// a const list of allowed values + `throw` on anything else).
//
// The Weeek option IDs behind SOURCE / DEAL_STATUS / DEAL_TYPE are NOT here — they
// differ per workspace and live in the profile (`weeek-refs.json`, see deal-refs.js).
// What is here is the closed set of roles we know how to ask about.

const {
  SOURCE_KINDS, DEAL_TYPES, COMMUNICATION_CHANNELS, TELEGRAM_ACCOUNTS, DEAL_REQUIREMENTS,
} = require('./deal-refs');
const { EVENT_KEYS, isKnownEvent, eventName } = require('./exhibitions');

/**
 * Field definitions. `kind: 'enum'` fields validate against `values`; 'text' and
 * 'date' are free-form but never null once set. `required` is the default and can
 * be relaxed per profile — the bot carried exactly these knobs as
 * WEEEK_REQUIRE_* vars, and they are business policy, not code.
 */
const FIELDS = {
  title:            { kind: 'text',  label: 'Название сделки',        required: true },
  companyInfo:      { kind: 'text',  label: 'Информация о компании',   required: true },
  contactName:      { kind: 'text',  label: 'Контакт (имя)',           required: true },
  contactPhone:     { kind: 'text',  label: 'Телефон',                 required: false },
  contactEmail:     { kind: 'text',  label: 'Email',                   required: false },
  source:           { kind: 'enum',  label: 'Источник (класс)',       values: SOURCE_KINDS, required: true },
  eventKey:         { kind: 'event', label: 'Выставка (event_key)',   values: EVENT_KEYS, required: false },
  sourceComment:    { kind: 'text',  label: 'Комментарий к источнику', required: false },
  dealType:         { kind: 'enum',  label: 'Тип сделки',              values: DEAL_TYPES, required: true },
  dealComment:      { kind: 'text',  label: 'Комментарий к сделке',    required: true },
  dealStatus:       { kind: 'ref',   label: 'Статус',                  required: false },
  nextTaskTitle:    { kind: 'text',  label: 'Следующая задача',        required: false },
  nextTaskDueText:  { kind: 'text',  label: 'Срок задачи',             required: false },
  communicationChannel: { kind: 'enum', label: 'Канал связи',          values: COMMUNICATION_CHANNELS, required: false },
  telegramAccount:  { kind: 'enum',  label: 'Telegram-аккаунт',        values: TELEGRAM_ACCOUNTS, required: false },
  telegramPeerId:   { kind: 'text',  label: 'Telegram peer id',        required: false },
};

const FIELD_NAMES = Object.keys(FIELDS);

/** Default requirement set, keyed by field name. */
const DEFAULT_REQUIREMENTS = Object.fromEntries(
  FIELD_NAMES.map(n => [n, FIELDS[n].required]),
);

function fieldNames() {
  return [...FIELD_NAMES];
}

function isKnownField(name) {
  return Object.hasOwn(FIELDS, String(name));
}

/**
 * Validate one field assignment.
 * Throws a typed error the agent can act on — same contract as the candidate-status
 * check in hh-skill. Returns the normalised value.
 */
function validateField(name, value, { requirements = DEFAULT_REQUIREMENTS } = {}) {
  const key = String(name);
  if (!isKnownField(key)) {
    throw new Error(`unknown deal field "${key}" — known fields: ${FIELD_NAMES.join(', ')}`);
  }
  const def = FIELDS[key];
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const v = String(value).trim();
  if (def.kind === 'enum' && !def.values.includes(v)) {
    throw new Error(`invalid ${key} "${v}" — must be one of: ${def.values.join(', ')}`);
  }
  if (def.kind === 'event' && !isKnownEvent(v)) {
    throw new Error(`invalid ${key} "${v}" — must be a known event_key: ${EVENT_KEYS.join(', ')}`);
  }
  if (def.kind === 'date') {
    if (Number.isNaN(Date.parse(v))) throw new Error(`invalid ${key} "${v}" — not a date`);
  }
  if (def.kind === 'ref' && !/^[a-z0-9_-]{1,64}$/i.test(v)) {
    // A ref names a role; the Weeek ID behind it comes from the profile map.
    throw new Error(`invalid ${key} "${v}" — expected a role name (letters/digits/_/-)`);
  }
  void requirements;
  return v;
}

/**
 * Merge validated values into a field bag.
 * A null value clears the field — that is how "Пропустить задачу" works.
 */
function applyFields(bag = {}, patch = {}, { requirements } = {}) {
  const next = { ...bag };
  for (const [name, value] of Object.entries(patch || {})) {
    const v = validateField(name, value, { requirements });
    if (v === null) delete next[name];
    else next[name] = v;
  }
  return next;
}

/**
 * Which required fields are still missing.
 * `requirements` overrides the defaults — the bot's WEEEK_REQUIRE_* vars.
 */
function missingRequired(fields = {}, requirements = DEAL_REQUIREMENTS) {
  const req = { ...DEFAULT_REQUIREMENTS, ...requirements };
  return FIELD_NAMES.filter(n => req[n] && !String(fields[n] || '').trim());
}

/** True when the bag is good enough for the operation. */
function isComplete(fields = {}, requirements = DEAL_REQUIREMENTS) {
  return missingRequired(fields, requirements).length === 0;
}

/**
 * Fields the agent still has to ask about, in the order the bot asked them.
 * Order matters: the wizard's flow exists so a half-typed deal lands somewhere
 * usable, and that ordering is the behavioural knowledge we are porting.
 */
const ASK_ORDER = [
  'title', 'companyInfo', 'contactName', 'contactPhone',
  'source', 'eventKey', 'sourceComment', 'dealType',
  'communicationChannel', 'telegramAccount', 'telegramPeerId',
  'nextTaskTitle', 'nextTaskDueText',
  'dealComment', 'dealStatus',
];

function nextMissing(fields = {}, requirements = DEAL_REQUIREMENTS) {
  const missing = new Set(missingRequired(fields, requirements));
  return ASK_ORDER.find(n => missing.has(n)) || null;
}

module.exports = {
  FIELDS, FIELD_NAMES, DEFAULT_REQUIREMENTS, ASK_ORDER,
  fieldNames, isKnownField, validateField, applyFields,
  missingRequired, isComplete, nextMissing,
};
