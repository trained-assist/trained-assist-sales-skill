'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Карточка команд бота → вызовы инструментов (sales-skill#19, G1/G2/G3/G4/G5/G7/G11)
//
// Зачем отдельный тул, а не текст в промпте: команды бота — это пользовательский
// сценарий, который агент обязан уметь выполнять после переезда аудитории sales
// на штатный шлюз. Промпт читается как прозу и легко теряет деталь; здесь каждая
// команда — строка таблицы с точным набором аргументов, поэтому агент не
// придумывает параметры и не путает похожие вызовы.
//
// Тул не делает ничего сам: он отдаёт карточку. Выполняет агент — через
// инструменты 30-weeek.js и 92-flexi-sales.js. Так карточка не расходится с
// реальными сигнатурами: она и есть источник правды о том, что умеют тулы.
//
// Команды — из flexi-exhibition-deal-bot/src/operator-help.js (telegramCommandsList).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../../data-paths.js');
const { readCredentialFile } = require('../../credential-store.js');

// Роли и их привязка к ID — из 30-weeek.js. Дублируем имена, а не импортируем
// константы: карточка обязана быть читаемой без загрузки всего модуля Weeek.
const STATUS_ROLES = [
  'Лид', 'Сообщение для ЛПР отправлено', 'Ждем фидбэк от ЛПР',
  'Планируем звонок/встречу', 'Назначен звонок/встреча', 'Проработка проекта',
  'Принимают решение', 'Направлено КП / договор', 'Контрактование',
  'Оплата аванса', 'Выиграно', 'Пауза', 'Не отвечают', 'Ожидание', 'Проиграно'
];

const FUNNEL_ROLES = ['Сколково', 'Партнеры'];

// ── Карточка ─────────────────────────────────────────────────────────────────

const CARD = [
  '# Команды бота → что вызвать',
  '',
  'Пользователь присылает команду бота или её смысл. Выполняй через инструменты,',
  'не пересказывай карточку. Если команда требует открытой сделки, а её нет —',
  'сначала найди её (см. /deals) и назови deal_id в ответе.',
  '',
  '## Проверки и справочники',
  '',
  '| команда | что вызвать |',
  '|---|---|',
  '| /start, /help | Ответь текстом: что умеешь. Инструменты не нужны. |',
  '| /chatid | Ответь chat_id из контекста сообщения. Инструменты не нужны. |',
  '| «есть ли доступ к CRM», «авторизована ли CRM» | `weeek_status` → по полю ok. Локально, без сети. |',
  '| «какие воронки/статусы» | `weeek_list_funnels`, затем `weeek_list_statuses(funnel_id)`. |',
  '| «привяжи роли» | `weeek_set_refs` — читает справочник и пишет привязку в профиль. |',
  '',
  '## Сделки',
  '',
  '| команда | что вызвать |',
  '|---|---|',
  '| /deals | `weeek_list_deals(status_id, limit=20)`. Назови id, название, статус. |',
  '| /new, /new_deal | Собери данные → `weeek_create_deal`. Обязательные поля — контракт G7, см. ниже. |',
  '| /new_partner | `weeek_create_deal` с `deal_type: "partner"`. |',
  '| /add_status | `weeek_update_deal(deal_id, status_id)`. Статус — по роли из привязки, не по имени. |',
  '| /add_channel | `weeek_update_deal(deal_id, custom_fields)` — источник сделки. |',
  '| /add_comment | `weeek_add_comment(deal_id, text)`. Нужна L2-сессия; без неё — честная ошибка. |',
  '| «добавь задачу», «на вторник» | `weeek_add_task(deal_id, title, due_date=YYYY-MM-DD)`. Дату считать от строки [Сейчас: …]. |',
  '| «удали тестовую сделку» | `weeek_delete_deal(deal_id)` — только после подтверждения и только тестовую. |',
  '| /cancel | Отменить черновик. Сессия сделки живёт у агента, файла нет — просто перестать её вести. |',
  '',
  '## Контакты',
  '',
  '| команда | что вызвать |',
  '|---|---|',
  '| «добавь контакт», «запиши в CRM» | `weeek_create_contact(name, phone?, email?, company?)`. |',
  '| «добавь визитку» | Разобрать имя/телефон из текста или подписи → `weeek_create_contact`. |',
  '| «найди контакт» | `weeek_list_contacts(query)` → их сделки через `weeek_list_deals`. |',
  '| «обнови контакт» | `weeek_update_contact(contact_id, name?, phone?, email?, company?)`. |',
  '',
  '## Предлиды',
  '',
  '| команда | что вызвать |',
  '|---|---|',
  '| /preleads | Черновики сделок в профиле: `~/users/<profile>/sales/preleads/`. Читать файлы, не D1. |',
  '| /new_prelead | Сохранить черновик в `sales/preleads/<id>.json` + `index.json`. |',
  '| /convert_prelead_<id> | Черновик → `weeek_create_deal`. Дедупликация по компании обязательна. |',
  '',
  '## Контракт обязательных полей (G7)',
  '',
  '`weeek_create_deal` падает с `DEAL_MISSING_REQUIRED_FIELDS`, если не задано:',
  '`status_id`, `title`, `source`, `deal_type`, `company_inn`, `deal_comment`, `contact_name`.',
  'Это не просьба дописать потом: собери все поля до вызова. Роли и их ID —',
  'через `weeek_set_refs` / `weeek_get_refs`; угадывать ID нельзя, они у каждого',
  'workspace свои.',
  '',
  '## Выставки',
  '',
  '| команда | что вызвать |',
  '|---|---|',
  '| «заметка по компании» | `flexi_add_note(company_name, note_text, company_id?, stand?)`. |',
  '| «отказ по компании» | `flexi_reject_company(company_name, company_id?)`. |',
  '| «снять отказ» | `flexi_unreject_company(company_name, company_id?)`. |',
  '| «создай сделку из карточки» | `flexi_deal_from_catalog(payload)` — payload из deep-link каталога. |',
  '| «дописать статус на сайт» | `flexi_sync_deal_status(event_key?, company_id?)`. Сделку не создаёт. |',
  '',
  '## Чего не делать',
  '',
  '- Не вызывать `weeek_create_deal` с пустыми обязательными полями — вернёт типизированную ошибку.',
  '- Не угадывать ID воронок/статусов/источников — только через привязку в профиле.',
  '- Не создавать сделку повторно: сначала `weeek_list_deals` по компании.',
  '- Не отвечать на команду пересказом этой карточки.',
].join('\n');

// ── Палитра команды по CRM ───────────────────────────────────────────────────
//
// Идея владельца: команды бота живут не в промпте, а в палитре под конкретную CRM,
// и палитра закрыта, пока не объявлен токен этой CRM. Токен хранится как
// ~/agent-tokens/<profile>/<crm_name> — имя CRM уже есть в пути токена, отдельная
// разметка не нужна.
//
// Пока CRM одна (Weeek) и палитра захардкожена. Но карта уже та, по которой будет
// работать общий случай: {имя CRM → палитра}. Подключение второй CRM — это одна
// строка в PALETTES плюс её палитра, а не правка логики.
const PALETTES = {
  weeek: CARD,
};

/** CRM, у которой в профиле объявлен токен. Порядок PALETTES = приоритет. */
function detectCrm(userId) {
  for (const name of Object.keys(PALETTES)) {
    try {
      const file = path.join(tokensRoot(), String(userId || process.env.USER_ID || ''), name);
      if (fs.existsSync(file)) return name;
    } catch { /* ignore */ }
  }
  return null;
}

// ── Локальные чтения ─────────────────────────────────────────────────────────

function clean(v) { return String(v ?? '').trim(); }

function readRefs(userId) {
  try {
    const file = path.join(tokensRoot(), String(userId || process.env.USER_ID || ''), 'weeek-refs.json');
    return JSON.parse(readCredentialFile(file)) || {};
  } catch { return {}; }
}


module.exports = {
  isReady: () => true,
  setupTools: [],
  tools: {

    crm_deals_commands: {
      description:
        'КОМАНДЫ CRM: карточка «команда → что вызвать» для сделок, контактов, предлидов и заметок выставки.\n\n' +
        'Это справочник команд, а не исполнитель. Вызывай его, когда пользователь присылает команду бота ' +
        '(/deals, /new_deal, /add_status, /add_comment, /preleads, /add_channel, /cancel, /chatid, /start, /help) ' +
        'или её смысл словами («добавь контакт», «запиши в CRM», «кинь визитку», «последние сделки», ' +
        '«отказ по компании»). Тул отдаёт карточку с точными вызовами — выполняй их через weeek_* и flexi_*.\n\n' +
        'Не путай: сам тул ничего не выполняет, он только называет команды и их аргументы. ' +
        'Если нужен не справочник, а действие — вызывай сразу weeek_* / flexi_*.\n\n' +
        'ВАЖНО: обязательные поля сделки (G7) собираются ДО вызова weeek_create_deal, а не после ошибки.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Команда или смысл запроса: /deals, /new_deal, /add_status, /add_comment, /preleads, /add_channel, /cancel, /chatid, /start, /help, «добавь контакт», «отказ по компании»…',
          },
          crm: { type: 'string', description: 'Имя CRM. Не указан — берётся CRM, по которой объявлен токен в профиле.' },
          deal_id: { type: 'string', description: 'ID открытой сделки, если известен' },
          company_name: { type: 'string', description: 'Название компании (для заметок и предлидов)' },
        },
      },
      handler: async ({ command, deal_id, company_name, crm }, ctx) => {
        const uid = ctx?.userId || process.env.USER_ID || '';
        const refs = readRefs(uid);

        // CRM выбирается явно или по объявленному токену. Токена нет — палитра не
        // выдаётся: без него половина вызовов всё равно упадёт, а карточка ввела бы
        // агента в заблуждение.
        const crmName = clean(crm) || detectCrm(uid);
        const palette = PALETTES[crmName];

        if (!palette) {
          return {
            ok: false,
            code: 'CRM_PALETTE_UNAVAILABLE',
            known_crms: Object.keys(PALETTES),
            hint: crmName
              ? `Для CRM «${crmName}» палитра команд не описана. Известные: ${Object.keys(PALETTES).join(', ')}.`
              : 'Токен CRM не найден в профиле — команды сделок выполнять нечем. Установи токен CRM и повтори.',
          };
        }

        const unbound = {
          statuses: STATUS_ROLES.filter(r => !(refs.statuses || {})[r]),
          funnels: FUNNEL_ROLES.filter(r => !(refs.funnels || {})[r]),
        };

        return {
          ok: true,
          crm: crmName,
          card: palette,
          context: {
            command: command || null,
            deal_id: deal_id || null,
            company_name: company_name || null,
            refs_bound: {
              statuses: Object.keys(refs.statuses || {}),
              funnels: Object.keys(refs.funnels || {}),
              deal_fields: Object.keys(refs.deal_fields || {}),
            },
            refs_unbound: unbound,
            hint: (unbound.statuses.length || unbound.funnels.length)
              ? 'Часть ролей не привязана к ID Weeek — вызови weeek_set_refs, иначе requireRef бросит ошибку.'
              : 'Роли привязаны, можно работать со сделками.',
          },
        };
      },
    },

  },
};

module.exports._test = { CARD, STATUS_ROLES, FUNNEL_ROLES };
