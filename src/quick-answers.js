'use strict';
// Expo/Flexi quick answers — deterministic replies read from disk, no LLM.
// Moved from trained-assist-agent core (src/runner/intent-engine.js, issue #1717).
// Contract with core: getQuickAnswer(task, { workDir, sessionExists }) → string | null.
// Core calls it from getQuickAnswer() for every sibling that ships this file;
// null means "not mine" and core keeps going.
const fs = require('fs');
const path = require('path');

const EXPO_CAPABILITY_INTENT = /(?:скил|skill|умееш|можешь|есть.{0,30}(?:скил|инструм|возможн)).{0,80}(?:участник|экспонент|выставк|expo)/i;
const EXPO_CRITERIA_INTENT  = /требовани.{0,20}(?:целев|квалиф)|критери.{0,20}(?:целев|отбор|выставк)|целев.{0,20}(?:критери|требовани)|покажи.{0,15}критери|мои.{0,10}критери|expo.{0,10}criteria|target.{0,10}criteria/i;
const EXPO_STATUS_INTENT    = /статус.{0,20}(?:пайплайн|pipeline|выставк|обработк)|pipeline.{0,10}статус|сколько.{0,15}целевых|сколько.{0,15}компаний.{0,20}(?:выставк|обработан|pipeline)|expo.{0,10}статус/i;
const EXPO_SITE_CONFIG_INTENT = /фильтр.{0,20}(?:сайт|каталог|выставк|диапазон)|сайт.{0,20}фильтр|диапазон.{0,20}(?:выручк|сайт)|настройк.{0,20}(?:сайт|каталог)|какие.{0,10}диапазон|revenue.*filter|site.*filter/i;

const pipelineTools = () => require('./mcp-skills/tools/87-expo-pipeline.js');
const { tokensRoot } = require('./data-paths.js');
const { readCredentialFile } = require('./credential-store.js');

// Команды CRM, которые читаются локально и не требуют сети. Всё, что пишет в CRM
// (создание сделки, смена статуса, комментарий), сюда не попадает: быстрый ответ
// по контракту ядра синхронный и без сети, а значит не может ходить в Weeek.
const CRM_STATUS_INTENT = /^(?:\/deals|\/preleads|\/new(?:_deal|_partner|_prelead)?|\/add_(?:status|channel|comment)|\/cancel|\/chatid|\/start|\/help)\s*$/i;
const CRM_CAPABILITY_INTENT = /(?:авторизован|есть.{0,20}(?:доступ|токен|подключени).{0,20}crm|crm.{0,20}(?:доступ|токен|подключен)|weeek.{0,20}(?:доступ|токен|подключен)|подключен.{0,20}crm)/i;

/**
 * Есть ли в профиле токен CRM. Локальное чтение файла, без сети.
 *
 * Профиль берётся из process.env.USER_ID: ядро зовёт getQuickAnswer без userId
 * (intent-engine.js:616), так что это единственный источник — как в 30-weeek.js.
 */
function crmTokenPresent() {
  try {
    const dir = path.join(tokensRoot(), String(process.env.USER_ID || ''));
    return fs.existsSync(path.join(dir, 'weeek'));
  } catch { return false; }
}

function pipelineStatus(pipelineBase) {
  const dirs = fs.readdirSync(pipelineBase, { withFileTypes: true }).filter(e => e.isDirectory());
  if (dirs.length === 0) return 'Нет активных pipeline. Запусти обработку выставки чтобы начать.';
  const lines = dirs.map(d => {
    const dir = path.join(pipelineBase, d.name);
    function count(f, key) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const arr = Array.isArray(data) ? data : (data[key] || data.companies || data.results || []);
        return arr.length;
      } catch (e) { console.warn('[sales-quick] expo count parse:', e.message); return null; }
    }
    const c = count('companies.json', 'companies');
    const e = count('enriched.json', 'companies');
    const t = count('targets.json', 'companies');
    return `📁 ${d.name}\n   Компаний: ${c ?? '—'} | Обогащено: ${e ?? '—'} | Целевых: ${t ?? '—'}`;
  });
  return '📊 Статус pipeline:\n\n' + lines.join('\n\n');
}

function getQuickAnswer(task, { workDir, sessionExists } = {}) {
  if (!task || !workDir) return null;

  // Команды CRM не про выставку: они читают токен из профиля и не требуют
  // expo-pipeline. Раньше стоял общий гейт «нет пайплайна — не наше», и ответы
  // про CRM были недостижимы в профиле без выставки.
  if (CRM_CAPABILITY_INTENT.test(task) || CRM_STATUS_INTENT.test(task)) {
    return crmQuickAnswer(task);
  }

  const pipelineBase = path.join(workDir, 'expo-pipeline');
  // Every answer below is about this profile's expo pipeline — no pipeline, not ours.
  if (!fs.existsSync(pipelineBase)) return null;

  if (EXPO_CAPABILITY_INTENT.test(task) && !sessionExists) {
    return 'Да, умею собирать участников выставок.\n\nДай мне ссылку на сайт выставки — зайду, найду страницу участников и верну список компаний в CSV.\n\nДальше могу обогатить по ИНН: директор, выручка, сайт — скидывай сразу с таким запросом, если нужно.\n\nПришли URL сайта выставки.';
  }
  // Length guard: long messages are instructions, not criteria/config lookup requests.
  try {
    if (EXPO_CRITERIA_INTENT.test(task) && task.length < 200) {
      const { formatCriteriaText, readCriteria } = pipelineTools();
      return formatCriteriaText(readCriteria(workDir));
    }
  } catch (e) { console.error('[sales-quick] expo criteria error:', e.message); }
  try {
    if (EXPO_SITE_CONFIG_INTENT.test(task) && task.length < 200) {
      const { formatSiteConfigText, readSiteConfig } = pipelineTools();
      return formatSiteConfigText(readSiteConfig(workDir));
    }
  } catch (e) { console.error('[sales-quick] expo site-config error:', e.message); }
  try {
    if (EXPO_STATUS_INTENT.test(task)) return pipelineStatus(pipelineBase);
  } catch (e) { console.error('[sales-quick] expo status error:', e.message); }

  return null;
}

/**
 * Быстрый ответ на команду CRM. Только локальное чтение токена: по контракту
 * ядра быстрый ответ синхронный и без сети, поэтому сами вызовы Weeek сюда не
 * попадают — они уходят в агента через crm_deals_commands.
 */
function crmQuickAnswer(task) {
  const connected = crmTokenPresent();
  const list = '/deals, /new_deal, /add_status, /add_comment, /preleads, /add_channel, /cancel';
  if (CRM_CAPABILITY_INTENT.test(task)) {
    return connected
      ? `Да, CRM подключена — токен на месте. Команды сделок выполняю: ${list}. Напиши команду или просто что нужно сделать.`
      : `CRM не подключена: токена нет. Подключи CRM (weeek_set_token), и команды сделок заработают: ${list}.`;
  }
  return connected
    ? `Команды сделок выполняю через CRM. Скажи, что именно: ${list} — или просто опиши действие.`
    : `CRM не подключена, поэтому команды сделок сейчас не выполнятся. Подключи CRM (weeek_set_token) — и ${list} заработают.`;
}

module.exports = {
  getQuickAnswer,
  EXPO_CAPABILITY_INTENT, EXPO_CRITERIA_INTENT, EXPO_STATUS_INTENT, EXPO_SITE_CONFIG_INTENT,
  CRM_CAPABILITY_INTENT, CRM_STATUS_INTENT, crmTokenPresent,
};
