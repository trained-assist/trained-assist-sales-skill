'use strict';

// expo_pipeline_run — полный оркестратор expo-пайплайна в одном инструменте.
//
// Шаги:
//   1. expo_find_participants (если нет exhibitors.json)
//   2. inn_enrich_batch батчами (max_batches за один вызов)
//   3. expo_pipeline_qualify + expo_build_catalog (когда всё обогащено)
//
// Возвращает прогресс после каждого вызова.
// Агент должен вызвать снова если next_action == 'call_again'.
// Если юзер хочет автодобивание без участия — создать крон через cron_create.

const fs   = require('fs');
const path = require('path');
const { expoDataDir, isExpoEnabled } = require('../expo-paths.js');

function slugify(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9а-яёА-ЯЁ]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 64).toLowerCase();
  } catch {
    return url.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64).toLowerCase();
  }
}

function fmtProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  return `${bar} ${done}/${total} (${pct}%)`;
}

module.exports = {
  isReady: isExpoEnabled,
  setupTools: [],
  tools: {

  expo_pipeline_run: {
    description: `Full expo pipeline orchestrator — runs all steps in sequence, reports progress.

Steps (auto-detected which ones are needed):
  1. expo_find_participants — scrape exhibitor list from expo website
  2. inn_enrich_batch — enrich companies with INN/revenue in batches (saves after each)
  3. expo_pipeline_qualify — filter by target criteria
  4. expo_build_catalog — generate HTML site ready to deploy

IMPORTANT USAGE PATTERN:
- Call once to start. Check next_action in the response:
  • "call_again" — enrichment in progress, call again with same params to continue
  • "done" — full pipeline complete, site built, publish with site_deploy(deploy.dir, deploy.project)
  • "create_cron" — too many companies to finish in one session, suggest cron to user

When next_action == "call_again", simply call expo_pipeline_run again with identical params.
The tool resumes from where it stopped — no data loss.

⚠️ НИКОГДА не пиши Python-скрипты для парсинга/обогащения вместо этого инструмента.
Причина: скрипты в /tmp теряют данные при перезапуске VM. Этот инструмент сохраняет
на диск после каждого батча и умеет продолжить с места остановки.

Публикация — отдельным вызовом site_deploy(dir, project) (trained-skills): сессия не имеет
учётки Cloudflare, публикует сервер.

For hands-free completion without user interaction, create a cron:
  cron_create with schedule "every 10 minutes" and prompt:
  "expo_pipeline_run для <expo_url> event_key=<key> пока не done"`,

    inputSchema: {
      type: 'object',
      required: ['expo_url', 'event_key', 'expo_title'],
      properties: {
        expo_url:      { type: 'string', description: 'URL страницы участников выставки' },
        event_key:     { type: 'string', description: 'Короткий ключ события, e.g. flowersexpo2026' },
        expo_title:    { type: 'string', description: 'Название для сайта, e.g. "Flowers Expo 2026"' },
        catalog_base:  { type: 'string', description: 'URL цифрового каталога выставки (или "")', default: '' },
        favicon_emoji: { type: 'string', description: 'Emoji для favicon', default: '🌸' },
        batch_size:    { type: 'number', description: 'Компаний за батч ИНН (default 20)', default: 20 },
        max_batches:   { type: 'number', description: 'Макс. батчей за один вызов (default 2)', default: 2 },
        production_okved: { type: 'array', items: { type: 'string' }, description: 'ОКВЭД-префиксы производства для t:1/nt:1. Default: ["13.","14."] (текстиль). Для цветов: ["01.","16.","20.","22.","23.","25.","26.","27.","28.","32."]' },
        auto_cron: { type: 'boolean', description: 'Если true и осталось >5 батчей — автоматически создать крон-задачу на каждые 10 минут для продолжения. По умолчанию false.', default: false },
        project_name: { type: 'string', description: 'Имя Cloudflare Pages проекта для site_deploy (default: expo_id slug)' },
      },
    },

    handler: async ({ expo_url, event_key, expo_title, catalog_base = '', favicon_emoji = '🌸', batch_size = 20, max_batches = 2, production_okved, auto_cron = false, project_name }, ctx) => {
      const workDir = ctx?.workDir || process.cwd();
      const expoId  = slugify(expo_url);
      // Project-aware: writes into the project's data/ when the session is bound
      // to an expo project, else the legacy expo-pipeline/<id>/ dir.
      const expoDir = expoDataDir(workDir, expoId);
      fs.mkdirSync(expoDir, { recursive: true });

      const log     = [];
      const stepLog = (msg) => { log.push(msg); process.stdout.write(msg + '\n'); };

      // ── Шаг 1: expo_find_participants ──────────────────────────────────────
      const exhibitorsPath = path.join(expoDir, 'exhibitors.json');
      let totalCompanies   = 0;

      if (!fs.existsSync(exhibitorsPath)) {
        stepLog(`🔍 Шаг 1/4: Ищу участников ${expo_url} …`);
        const expoTool = require('./85-expo.js').tools.expo_find_participants;
        const found    = await expoTool.handler({ site_url: expo_url, max_companies: 1000 });

        if (found.error || found.warning) {
          return {
            ok: false,
            step: 'find_participants',
            error: found.error || found.warning,
            hint: found.hint || 'Попробуй передать HTML страницы участников в expo_parse_participants.',
            expo_id: expoId,
          };
        }

        const companies = found.companies || [];
        fs.writeFileSync(exhibitorsPath, JSON.stringify(companies, null, 2), 'utf8');

        // Save pipeline meta
        const pipelinePath = path.join(expoDir, 'pipeline.json');
        fs.writeFileSync(pipelinePath, JSON.stringify({
          source_url: expo_url, expo_id: expoId, event_key, expo_title,
          catalog_base, favicon_emoji,
          steps: { find: { done: true, count: companies.length, at: new Date().toISOString() } },
        }, null, 2), 'utf8');

        stepLog(`✅ Найдено ${companies.length} участников`);
        totalCompanies = companies.length;
      } else {
        const ex = JSON.parse(fs.readFileSync(exhibitorsPath, 'utf8'));
        totalCompanies = ex.length;
        stepLog(`✅ Шаг 1/4: Участники уже собраны (${totalCompanies})`);
      }

      // ── Шаг 2: inn_enrich_batch (до max_batches батчей) ──────────────────
      const enrichTool = require('./70-inn-enrichment.js').tools.inn_enrich_batch;

      let batchesDone  = 0;
      let lastEnrichResult;
      let lastBuiltPath = null;

      const buildTool   = require('./88-expo-catalog.js').tools.expo_build_catalog;

      while (batchesDone < max_batches) {
        const result = await enrichTool.handler({
          file: exhibitorsPath,
          out_dir: expoDir,
          batch_size,
          resume: true,
        }, ctx);

        lastEnrichResult = result;

        if (result.error) {
          return { ok: false, step: 'inn_enrich_batch', error: result.error, expo_id: expoId };
        }

        batchesDone++;
        stepLog(`🔍 Шаг 2/4: ИНН ${fmtProgress(result.done, result.total)} — ИНН найдено: ${result.with_inn ?? '?'}`);

        // Rebuild catalog after every batch so the site is always fresh with partial data
        const built = await buildTool.handler({
          expo_id: expoId, event_key, expo_title, catalog_base, favicon_emoji,
          use_targets: false,
          ...(production_okved ? { production_okved } : {}),
        }, ctx);
        if (!built.error) lastBuiltPath = built.outputPath;

        if (result.remaining === 0) break;
      }

      const enrichDone      = lastEnrichResult?.done      ?? 0;
      const enrichTotal     = lastEnrichResult?.total     ?? totalCompanies;
      const enrichRemaining = lastEnrichResult?.remaining ?? 0;

      // Ещё не всё обогащено — вернём прогресс + путь к частичному сайту
      if (enrichRemaining > 0) {
        const batchesLeft = Math.ceil(enrichRemaining / batch_size);
        const offerCron   = batchesLeft > 5;

        let cronResult = null;
        let cronError = null;
        if (auto_cron && offerCron) {
          // Auto-continuation used core's in-process cron_create (04-cron). Core's
          // prompt-cron is disabled until the cron-service lands
          // (trained-assist-agent#1489: cron_create returns SCHEDULER_UNAVAILABLE), so
          // report exactly that instead of reaching into core. When #1489 ships, schedule
          // through core's provider jobs API (POST /internal/cron/jobs), like hh-skill does.
          cronError = 'Расписания сейчас не работают: задача НЕ создана и сама запускаться не будет (trained-assist-agent#1489). Запускай expo_pipeline_run вручную.';
          stepLog(`⚠️ Крон не создан: ${cronError}`);
        }

        const msg = [
          `⏳ Обработано ${enrichDone} из ${enrichTotal} компаний`,
          `Осталось: ${enrichRemaining} (≈ ${batchesLeft} батчей по ${batch_size})`,
          lastBuiltPath ? `🏗️ Частичный сайт обновлён: ${lastBuiltPath}` : '',
          '',
          cronResult
            ? `✅ Крон-задача создана — пайплайн продолжится автоматически каждые 10 минут.`
            : cronError
              ? `⚠️ Автопродолжение по расписанию не включено: ${cronError}\n▶️ Напиши "продолжить" — обработаю следующий батч.`
            : offerCron
              ? '▶️ Напиши "продолжить" — обработаю следующий батч. (Автодобивание по расписанию временно недоступно, #1489.)'
              : '▶️ Напиши "продолжить" — обработаю следующий батч.',
        ].filter(Boolean).join('\n');

        return {
          ok: true,
          next_action:   cronResult ? 'cron_scheduled' : 'call_again',
          step:          'inn_enrich_batch',
          progress:      { done: enrichDone, total: enrichTotal, remaining: enrichRemaining, pct: Math.round(enrichDone / enrichTotal * 100) },
          partial_site:  lastBuiltPath,
          message:       msg,
          cron_id:       cronResult?.id || null,
          cron_prompt:   offerCron ? `Продолжай вызывать expo_pipeline_run для ${expo_url} с event_key=${event_key} и expo_title="${expo_title}" пока next_action != "done". Вызывай каждые 10 минут.` : null,
          expo_id:       expoId,
          log,
        };
      }

      // ── Шаг 3: expo_pipeline_qualify ──────────────────────────────────────
      stepLog('🎯 Шаг 3/4: Квалификация целевых компаний…');
      const qualifyTool = require('./87-expo-pipeline.js').tools.expo_pipeline_qualify;
      const qualified   = await qualifyTool.handler({ expo_id: expoId }, ctx);

      if (qualified.error) {
        stepLog(`⚠️ Квалификация: ${qualified.error}`);
      } else {
        stepLog(`✅ Целевых: ${qualified.qualified}, отсеяно: ${qualified.rejected}`);
      }

      // ── Шаг 4: expo_build_catalog (финальный — все данные есть) ──────────
      stepLog('🏗️ Шаг 4/4: Финальный каталог…');
      const built = await buildTool.handler({
        expo_id: expoId, event_key, expo_title, catalog_base, favicon_emoji,
        use_targets: false,
        ...(production_okved ? { production_okved } : {}),
      }, ctx);

      if (built.error) {
        return { ok: false, step: 'expo_build_catalog', error: built.error, expo_id: expoId };
      }

      stepLog(`✅ Сайт готов: ${built.outputPath}`);

      const summary = [
        `✅ Пайплайн завершён для "${expo_title}"`,
        '',
        `📋 Участников: ${enrichTotal}`,
        `🔍 С ИНН: ${lastEnrichResult?.with_inn ?? '?'}`,
        !qualified.error ? `🎯 Целевых: ${qualified.qualified} | Почти целевых: —` : '',
        '',
        `🚀 Опубликуй: site_deploy(dir="${built.deploy.dir}", project="${project_name || built.deploy.project}")`,
      ].filter(s => s !== undefined).join('\n');

      return {
        ok: true,
        next_action: 'done',
        step: 'complete',
        message: summary,
        stats: {
          total:     enrichTotal,
          with_inn:  lastEnrichResult?.with_inn,
          targets:   qualified.qualified,
          rejected:  qualified.rejected,
        },
        output_path: built.outputPath,
        deploy:      { ...built.deploy, ...(project_name ? { project: project_name } : {}) },
        expo_id:     expoId,
        log,
      };
    },
  },

}};
