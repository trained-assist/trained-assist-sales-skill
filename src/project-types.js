'use strict';
// Project types contributed by the sales domain — merged into core's type registry
// (trained-assist-agent src/projects.js, issue #1717). Same schema as core's TYPES:
// { label, prefixes, dirs, seedFiles, profile }.
module.exports = {
  expo: {
    label: 'Выставка',
    prefixes: ['expo', 'выставка', 'exhibition', 'экспо'],
    // Shown to the project-classifier LLMs (core project-summary / reproject).
    classifierHint: 'выставки/каталоги участников',
    dirs: ['site', 'site/_archive', 'deploy', 'data'],
    seedFiles: {
      'EVENT.md':
        '# Выставка\n\n' +
        '- EVENT_KEY: <напр. flowersexpo2026>\n' +
        '- Дата / город:\n' +
        '- Каталог-сайт: site/<slug>.html → deploy/<slug>/index.html\n' +
        '- Telegram-бот: deploy/<slug>/telegram_companies.json\n' +
        '- Деплой: npx wrangler pages deploy deploy/<slug> --project-name <slug>\n',
    },
    profile:
      '# Домен проекта: Выставка (Flexi)\n\n' +
      '- Одна выставка = один проект. Time-boxed: собрали участников → каталог → отработали стенды → закрыли.\n' +
      '- Каталог-сайт живёт в site/, собранный деплой — в deploy/<slug>/ (index.html + telegram_companies.json).\n' +
      '- Пер-выставочные pipeline-данные (участники, ИНН, финансы, EX-массив) — в data/, не в корень профиля.\n' +
      '- Общие данные (brands.json, cpm-list.json, критерии классификации) — durable-инфра профиля, НЕ копируются в проект.\n' +
      '- Классификация target/near-target и revenue-фильтры — через expo_* инструменты.\n' +
      '- Деплой: npx wrangler pages deploy deploy/<slug> --project-name <slug>.\n',
  },
};
