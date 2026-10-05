'use strict';

// Единый источник адреса API заметок (sales-skill#19, C1).
//
// Почему отдельный модуль, а не константа в 92-flexi-sales.js: адрес нужен
// двум независимым сторонам — инструментам агента (92-flexi-sales.js) и
// генератору каталога (88-expo-catalog.js, который подставляет его в
// собираемый index.html). Две копии одного адреса разъезжаются: так
// и случилось — инструменты указывали на flexi-site-notes, а в шаблоне
// каталога остался flexi-telegram-deal-bot, который по решению владельца
// выключается (issue #19, шаг 11). Каталог, собранный из шаблона, писал бы
// заметки в воркер, который скоро не отвечает, и заметки пропали бы молча.
//
// Адрес резолвится на чтении, а не на загрузке модуля: переопределение
// FLEXI_NOTES_API_URL должно работать и после того, как модуль ужеrequire'нут.

const DEFAULT_ORIGIN = 'https://flexi-site-notes.skillset-apply.workers.dev';
const NOTES_PATH = '/api/site-predeal-notes';

/** Origin API заметок: https-адрес без пути и без слэша на конце. */
function notesOrigin() {
  const raw = String(process.env.FLEXI_NOTES_API_URL || '').trim();
  const value = raw || DEFAULT_ORIGIN;
  return value.replace(/\/+$/, '');
}

/** Полный URL эндпоинта заметок. */
function notesApiUrl() {
  // Переопределение может уже содержать путь эндпоинта (так его задавали
  // раньше) — тогда не дописываем его второй раз.
  const raw = String(process.env.FLEXI_NOTES_API_URL || '').trim();
  if (raw && /\/api\/site-predeal-notes/.test(raw)) return raw.replace(/\/+$/, '');
  return notesOrigin() + NOTES_PATH;
}

/** URL /health того же воркера — для flexi_status. */
function notesHealthUrl() {
  return notesOrigin() + '/health';
}

/** JSON-литерал для вставки в собираемый HTML. */
function notesApiLiteral() {
  return JSON.stringify(notesApiUrl());
}

module.exports = {
  DEFAULT_ORIGIN,
  NOTES_PATH,
  notesOrigin,
  notesApiUrl,
  notesHealthUrl,
  notesApiLiteral,
};