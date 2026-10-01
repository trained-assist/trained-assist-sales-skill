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

module.exports = {
  getQuickAnswer,
  EXPO_CAPABILITY_INTENT, EXPO_CRITERIA_INTENT, EXPO_STATUS_INTENT, EXPO_SITE_CONFIG_INTENT,
};
