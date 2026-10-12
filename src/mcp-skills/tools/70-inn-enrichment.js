'use strict';

const fs = require('fs');
const path = require('path');
const { enrich } = require('../../inn-pipeline/index');

// One store for DaData/Checko/Rusprofile keys, shared with dadata_*/checko_*/company_*.
const { readKeys: readConfig, writeKeys: writeConfig } = require('../inn-keys');

function companyKey(company) {
  return String(company.id ?? company.name ?? '').toLowerCase();
}

function completed(company) {
  const status = company?._inn_enrichment?.status;
  if (status === 'found' || status === 'unresolved' || status === 'low_confidence'
      || status === 'not_applicable') return true;
  // Older checkpoints have no status. Only an enrichment-owned provenance marker
  // proves that the row was processed; a copied source row with an INN does not.
  return !status && !!(company?.requisites_source || company?.requisites_comment);
}

module.exports = {
  tools: {

    inn_status: {
      description: 'Show INN enrichment skill status: which API keys are configured, cache location, and a brief description of data sources.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_, ctx) => {
        const cfg = readConfig(ctx?.userId);
        const src = cfg._sources || {};
        function credStatus(key, freeDefault) {
          if (cfg[key]) return { status: 'configured', origin: src[key] || 'user' };
          return { status: freeDefault ? 'ready' : 'not_configured' };
        }
        return {
          sources: {
            bfo_nalog:  { status: 'ready',  note: 'Free, no auth. Main source.' },
            egrul:      { status: 'ready',  note: 'Free, no auth. Director lookup.' },
            dadata:     { ...credStatus('dadataToken'), note: 'Paid. Faster fallback.' },
            checko:     { ...credStatus('checkoKey'),  note: 'Paid. Financial data.' },
            rusprofile: { ...credStatus('rusprofileCookie', true), note: 'Free scraping. Set cookie if blocked.' },
          },
          cache_dir: path.join(process.cwd(), '.inn-cache'),
        };
      },
    },

    inn_set_dadata_token: {
      description: 'Save DaData API credentials for INN enrichment. Get them at dadata.ru → Profile → API keys.',
      inputSchema: {
        type: 'object',
        required: ['token', 'secret'],
        properties: {
          token:  { type: 'string', description: 'DaData API token (Authorization: Token ...)' },
          secret: { type: 'string', description: 'DaData secret key (X-Secret header)' },
        },
      },
      handler: async ({ token, secret }, ctx) => {
        writeConfig(ctx?.userId, { dadataToken: token, dadataSecret: secret });
        return { ok: true, message: 'DaData credentials saved.' };
      },
    },

    inn_set_checko_key: {
      description: 'Save Checko API key for financial data (revenue, profit by INN). Get it at checko.ru.',
      inputSchema: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', description: 'Checko API key' } },
      },
      handler: async ({ key }, ctx) => {
        writeConfig(ctx?.userId, { checkoKey: key });
        return { ok: true, message: 'Checko API key saved.' };
      },
    },

    inn_set_rusprofile_cookie: {
      description: 'Save Rusprofile session cookie (needed if rusprofile starts masking data with ░ symbols). Get from browser DevTools → Application → Cookies → rusprofile.ru.',
      inputSchema: {
        type: 'object',
        required: ['cookie'],
        properties: { cookie: { type: 'string', description: 'Raw Cookie header value from browser' } },
      },
      handler: async ({ cookie }, ctx) => {
        writeConfig(ctx?.userId, { rusprofileCookie: cookie });
        return { ok: true, message: 'Rusprofile cookie saved.' };
      },
    },

    inn_enrich_batch: {
      description: `Enrich a list of Russian companies with INN, OGRN, director, revenue, and profit.
Sources (in priority order): BFO ФНС (free), company websites, DaData, ЕГРЮЛ, Checko.
Input: EITHER a path to exhibitors.json OR inline companies array.
Output: writes enriched.json (and requisites_enrichment.json alias) + requisites_report.json to out_dir.

BATCH MODE (default): processes batch_size companies at a time, saves after each batch.
Safe to run multiple times — already-enriched companies are skipped (resume=true by default).
For 300 companies run in batches of 20: call repeatedly, each call takes ~2 min, saves progress.

Progress is always written to disk after each batch — a timeout never loses more than one batch.

⚠️ ВАЖНО: НИКОГДА не пиши Python/shell-скрипты для ИНН-обогащения вместо этого инструмента.
Причина: скрипты в /tmp теряют данные при перезапуске VM. Этот инструмент сохраняет на диск
после каждого батча и умеет продолжить с места остановки через resume=true.
Используй expo_pipeline_run для полного пайплайна (парсинг + обогащение + деплой).

NOTE: Works well for Russian legal entity names. Brand names (Latin, foreign) → poor match rate.`,
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Path to exhibitors.json (array of {id, name, ...}). Use this OR companies.',
          },
          companies: {
            type: 'array',
            items: { type: 'object' },
            description: 'Inline array of {id, name, city?, website?}.',
          },
          out_dir: {
            type: 'string',
            description: 'Directory for output files (default: input file dir, or cwd for inline companies).',
          },
          batch_size: {
            type: 'number',
            description: 'Companies per batch before saving checkpoint (default: 20, min: 1, max: 50).',
          },
          resume: {
            type: 'boolean',
            description: 'Skip already-enriched companies from a previous run (default: true). Set false to re-enrich all.',
          },
          workers: {
            type: 'number',
            description: 'Parallel workers within a batch (default: 5, max: 10)',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Limit to specific sources: ["bfo","dadata","egrul","checko","site"]. Default: all.',
          },
        },
      },
      handler: async ({ file, companies, out_dir, batch_size = 20, resume = true, workers = 5, sources }, ctx) => {
        let exhibitors;
        let outDir;

        if (companies && Array.isArray(companies) && companies.length > 0) {
          exhibitors = companies.map((c, i) => ({ id: c.id ?? i + 1, name: c.name ?? c, ...c }));
          outDir = out_dir ? path.resolve(out_dir) : process.cwd();
        } else if (file) {
          const filePath = path.resolve(file);
          if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
          try {
            exhibitors = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(exhibitors)) return { error: 'exhibitors.json must be a JSON array' };
          } catch (e) {
            return { error: `Failed to parse ${filePath}: ${e.message}` };
          }
          outDir = out_dir ? path.resolve(out_dir) : path.dirname(filePath);
        } else {
          return { error: 'Нужен file (путь) или companies (массив объектов {name, ...})' };
        }

        const keys = exhibitors.map(companyKey);
        if (keys.some(key => !key) || new Set(keys).size !== keys.length) {
          return { error: 'Каждой компании нужен уникальный id или name для безопасного возобновления.' };
        }

        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        const enrichedPath = path.join(outDir, 'enriched.json');
        const enrichedAliasPath = path.join(outDir, 'requisites_enrichment.json');
        const reportPath = path.join(outDir, 'requisites_report.json');

        // Load existing results for resume
        const savedByKey = new Map();
        if (resume) {
          for (const p of [enrichedPath, enrichedAliasPath]) {
            if (fs.existsSync(p)) {
              try {
                const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
                const arr = Array.isArray(saved) ? saved : (saved.companies || []);
                for (const c of arr) if (companyKey(c)) savedByKey.set(companyKey(c), c);
              } catch {}
              break;
            }
          }
        }

        const remaining = exhibitors.filter(c => !completed(savedByKey.get(companyKey(c))));

        const skipped = exhibitors.length - remaining.length;
        if (remaining.length === 0) {
          const all = exhibitors.map(c => savedByKey.get(companyKey(c)) || c);
          const withInn = all.filter(c => c.inn).length;
          return {
            ok: true,
            total: exhibitors.length,
            done: skipped,
            remaining: 0,
            skipped,
            with_inn: withInn,
            message: `Все ${all.length} компаний уже обогащены. Запусти expo_pipeline_qualify для фильтрации.`,
            enrichedPath,
          };
        }

        const cfg = readConfig(ctx?.userId);
        const cacheDir = path.join(outDir, '.inn-cache');
        const config = {
          dadataToken: cfg.dadataToken || null,
          dadataSecret: cfg.dadataSecret || null,
          checkoKey: cfg.checkoKey || null,
          cacheDir,
          workers: Math.min(workers, 10),
        };

        const batchSz = Math.max(1, Math.min(batch_size, 50));
        const batch = remaining.slice(0, batchSz);
        const started = Date.now();
        const log = [];

        // enrich() returns an object keyed by company.id || company.name, not an
        // array. It omits unresolved rows, so onProgress distinguishes an
        // attempted row from a row that has never been attempted.
        const observed = new Map();

        const enrichResult = await enrich(batch, config, ({ done, total, company, result }) => {
          observed.set(companyKey(company), result);
          if (result?.inn) log.push(`✓ ${company.name} → ${result.inn}`);
          else log.push(`✗ ${company.name}`);
        });
        const found = enrichResult?.enriched;
        if (!found || typeof found !== 'object' || Array.isArray(found)) {
          return { error: 'inn-pipeline returned an unexpected enriched result shape.' };
        }
        for (const orig of batch) {
          const key = companyKey(orig);
          // Older inn-pipeline implementations use name when id is falsy (0).
          const details = found[String(orig.id || orig.name)] ?? observed.get(key) ?? null;
          const country = String(orig.country || '').toUpperCase();
          const isRussian = !country || ['RUS', 'RU', 'РОССИЯ'].includes(country);
          const status = !isRussian ? 'not_applicable'
            : details?.requisites_comment === 'bad_match_cleared' ? 'low_confidence'
            : details?.inn || details?.ogrn || details?.requisites_source ? 'found'
            : 'unresolved'; // The upstream API cannot yet distinguish no match from outage.
          savedByKey.set(key, {
            ...orig,
            ...(details || {}),
            id: orig.id,
            name: orig.name,
            _inn_enrichment: { status },
          });
        }

        // Keep source rows in the partial catalog, but leave unattempted rows
        // explicitly pending. Presence in enriched.json is not completion.
        const allResults = exhibitors.map(orig => savedByKey.get(companyKey(orig)) || {
          ...orig, _inn_enrichment: { status: 'pending' },
        });
        const elapsed = Math.round((Date.now() - started) / 1000);

        // Save checkpoint — both filenames for compatibility
        const json = JSON.stringify(allResults, null, 2);
        fs.writeFileSync(enrichedPath, json, 'utf8');
        fs.writeFileSync(enrichedAliasPath, json, 'utf8');

        // Save simple report
        const withInn = allResults.filter(c => c.inn);
        const totalDone = allResults.filter(completed).length;
        const stillRemaining = exhibitors.length - totalDone;
        const report = {
          total: exhibitors.length,
          enriched: totalDone,
          pending: stillRemaining,
          with_inn: withInn.length,
          without_inn: allResults.length - withInn.length,
          generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        return {
          ok: true,
          batch_processed: batch.length,
          elapsed_sec: elapsed,
          total: exhibitors.length,
          done: totalDone,
          remaining: stillRemaining,
          skipped,
          progress_pct: Math.round(totalDone / exhibitors.length * 100),
          with_inn: withInn.length,
          enrichedPath,
          log: log.slice(-30),
          next_step: stillRemaining > 0
            ? `Ещё ${stillRemaining} компаний. Вызови inn_enrich_batch снова с теми же параметрами — продолжит с места остановки.`
            : `Все компании обогащены. Запусти expo_pipeline_qualify для фильтрации.`,
        };
      },
    },

  },
};
