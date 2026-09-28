'use strict';

const fs = require('fs');
const path = require('path');
const { expoDataDir, expoDeployDir, isExpoEnabled } = require('../expo-paths.js');

const TEMPLATE_PATH = path.join(__dirname, '../../catalog-template/index.html');

function slugify(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64)
      .toLowerCase();
  } catch {
    return url.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64).toLowerCase();
  }
}

module.exports = {
  isReady: isExpoEnabled,
  setupTools: [],
  tools: {

    expo_build_catalog: {
      description: `Build a ready-to-deploy HTML exhibition catalog from enriched+classified company data.

Reads enriched.json (or targets.json) from the expo pipeline directory, applies
expo_generate_ex_array classification, injects the EX array into the HTML template,
and writes index.html to the expo dir (or out_dir).

After this, publish with the trained-skills tool site_deploy(dir=<out_dir>, project=<slug>)
(the session has no Cloudflare credentials, so never run npx wrangler yourself).

Use when user says: "сделай каталог", "собери сайт выставки", "создай каталог участников",
"задеплой каталог", "собери index.html".

Parameters:
- expo_id:       pipeline ID (from expo_pipeline_status) OR expo source URL (auto-slugifies)
- event_key:     short alphanumeric ID for this event, e.g. "flowersexpo2026"
- expo_title:    human title shown in browser tab, e.g. "Flowers Expo 2026"
- expo_date:     date label shown in header, e.g. "Осень 2026" (default: "")
- catalog_base:  URL of the exhibitor's digital catalog, or "" if none
- favicon_emoji: one emoji for the browser-tab icon (default "🌸")
- out_dir:       where to write index.html (default: expo pipeline dir)
- use_targets:   if true, use targets.json (qualified only); if false, use enriched.json (all)`,

      inputSchema: {
        type: 'object',
        required: ['expo_id', 'event_key', 'expo_title'],
        properties: {
          expo_id:       { type: 'string', description: 'Pipeline ID or source URL' },
          event_key:     { type: 'string', description: 'Alphanumeric event key, e.g. flowersexpo2026' },
          expo_title:    { type: 'string', description: 'Human title, e.g. Flowers Expo 2026' },
          expo_date:     { type: 'string', description: 'Date label for header, e.g. "Осень 2026"', default: '' },
          catalog_base:  { type: 'string', description: 'URL of digital catalog site, or ""', default: '' },
          favicon_emoji: { type: 'string', description: 'Browser tab emoji', default: '🌸' },
          out_dir:       { type: 'string', description: 'Output directory (default: expo pipeline dir)' },
          use_targets:   { type: 'boolean', description: 'Use targets.json instead of enriched.json', default: false },
          production_okved: { type: 'array', items: { type: 'string' }, description: 'ОКВЭД-префиксы производства для классификации t:1/nt:1. Default: ["13.","14."] (текстиль). Для цветов: ["01.","16.","20.","22.","23.","25.","26.","27.","28.","32."]' },
        },
      },

      handler: async ({ expo_id, event_key, expo_title, expo_date = '', catalog_base = '', favicon_emoji = '🌸', out_dir, use_targets = false, production_okved }, ctx) => {
        const workDir = ctx?.workDir || process.cwd();

        const id = expo_id.startsWith('http') ? slugify(expo_id) : expo_id;
        const expoDir = expoDataDir(workDir, id);

        // Find source data file
        const candidates = use_targets
          ? ['targets.json']
          : ['enriched.json', 'requisites_enrichment.json'];
        let dataFile = null;
        for (const f of candidates) {
          const p = path.join(expoDir, f);
          if (fs.existsSync(p)) { dataFile = p; break; }
        }
        if (!dataFile) {
          return {
            error: `No data file found in ${expoDir}. Run inn_enrich_batch first.`,
            expo_id: id,
            hint: use_targets ? 'targets.json not found — run expo_pipeline_qualify first' : 'enriched.json not found — run inn_enrich_batch first',
          };
        }

        let companies;
        try { companies = JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
        catch (e) { return { error: `Failed to parse ${path.basename(dataFile)}: ${e.message}` }; }
        if (!Array.isArray(companies)) companies = companies.companies || companies.results || [];

        // Build EX array — use expo_generate_ex_array for proper classification
        let exArray;
        try {
          const flexi = require('./86-expo-flexi.js');
          const genTool = flexi.tools.expo_generate_ex_array;
          const result = await genTool.handler({
            companies,
            id_prefix: id.slice(0, 3).toUpperCase(),
            sort_by_stand: true,
            ...(production_okved ? { production_okved } : {}),
          });
          exArray = JSON.parse(result.ex_json);
        } catch {
          // Fallback: pass through data with minimal mapping
          exArray = companies.map((c, i) => ({
            id: c.id || `EX${String(i + 1).padStart(3, '0')}`,
            n: c.name || c.n || '',
            s: c.stand || c.s || '',
            t: c.t ?? 0,
            nt: c.nt ?? 0,
            b: c.b || '',
            inn: c.inn || null,
            ogrn: c.ogrn || null,
            w: c.website || c.w || null,
            e: c.email || c.e || null,
            p: c.phone || c.p || null,
            ru: c.ru ?? 1,
            rev: c.rev || null, ry: c.ry || null,
            prof: c.prof || null, py: c.py || null,
            dir: c.dir || null,
          }));
        }

        // Read template
        if (!fs.existsSync(TEMPLATE_PATH)) {
          return { error: `Catalog template not found at ${TEMPLATE_PATH}` };
        }
        let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

        // Inject all placeholders
        const exJson = JSON.stringify(exArray);
        html = html
          .replace(/\{\{EXPO_TITLE\}\}/g, expo_title)
          .replace(/\{\{EVENT_KEY\}\}/g, event_key)
          .replace(/\{\{CATALOG_BASE\}\}/g, catalog_base)
          .replace(/\{\{FAVICON_EMOJI\}\}/g, favicon_emoji)
          .replace(/\{\{EXPO_DATE\}\}/g, expo_date)
          .replace('{{EX_JSON}}', exJson);

        // Write output — into the clean deployable dir (deploy/<slug>/ in a project,
        // legacy expo-pipeline/<id>/ otherwise), never the data dir with its inputs.
        const outputDir = out_dir ? path.resolve(out_dir) : expoDeployDir(workDir, id);
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'index.html');
        fs.writeFileSync(outputPath, html, 'utf8');

        const targets = exArray.filter(e => e.t === 1);
        const near = exArray.filter(e => e.nt === 1);
        const withInn = exArray.filter(e => e.inn);
        const withRev = exArray.filter(e => e.rev != null);

        const deploy = { tool: 'site_deploy', dir: outputDir, project: id };

        return {
          ok: true,
          outputPath,
          size_kb: Math.round(html.length / 1024),
          stats: {
            total: exArray.length,
            targets: targets.length,
            near_targets: near.length,
            with_inn: withInn.length,
            with_revenue: withRev.length,
          },
          deploy,
          next_step: `Каталог собран (${exArray.length} компаний, ${targets.length} целевых).\nОпубликуй: site_deploy(dir="${outputDir}", project="${id}")`,
        };
      },
    },

    expo_deploy_catalog: {
      description: `Resolve where an already-built expo catalog lives and hand it to site_deploy.
Does NOT publish by itself: publishing goes through the trained-skills tool
site_deploy(dir, project), which uses the profile's own Cloudflare token or the
shared default and guards project ownership. Call site_deploy with the returned args.`,

      inputSchema: {
        type: 'object',
        required: ['expo_id'],
        properties: {
          expo_id:      { type: 'string', description: 'Pipeline ID or source URL (same as used in expo_build_catalog)' },
          out_dir:      { type: 'string', description: 'Directory containing index.html (default: expo pipeline dir)' },
          project_name: { type: 'string', description: 'Cloudflare Pages project name (default: expo_id slug)' },
        },
      },

      handler: async ({ expo_id, out_dir, project_name }, ctx) => {
        const workDir = ctx?.workDir || process.cwd();
        const id = expo_id.startsWith('http') ? slugify(expo_id) : expo_id;
        const deployDir = out_dir ? path.resolve(workDir, out_dir) : expoDeployDir(workDir, id);
        const slug = project_name || id;

        const indexPath = path.join(deployDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
          return {
            error: `index.html not found at ${indexPath}. Run expo_build_catalog first.`,
            build_cmd: `expo_build_catalog with expo_id="${expo_id}"`,
          };
        }

        // Publishing moved to the server-side site_deploy (agent #1774): the
        // session process has no Cloudflare credentials after run isolation.
        return {
          ok: false,
          published: false,
          next_tool: 'site_deploy',
          args: { dir: deployDir, project: slug },
          next_step: `Каталог готов. Опубликуй: site_deploy(dir="${deployDir}", project="${slug}")`,
        };
      },
    },

  },
};
