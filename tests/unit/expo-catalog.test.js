import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const catalogMod = require('../../src/mcp-skills/tools/88-expo-catalog.js');
const { expo_build_catalog, expo_deploy_catalog } = catalogMod.tools;

const TEMPLATE_PATH = fileURLToPath(new URL('../../src/catalog-template/index.html', import.meta.url));

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'expo-catalog-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const ctx = () => ({ workDir });

function makeEnriched(companies, expoId = 'test-expo') {
  const dir = join(workDir, 'expo-pipeline', expoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'enriched.json'), JSON.stringify(companies));
  return dir;
}

const SAMPLE_COMPANIES = [
  { id: 'C001', name: 'Альфа Текстиль', inn: '7701234567', okved: '14.12', rev: 500, prof: 30, ru: 1, country: 'Россия', stand: 'A01' },
  { id: 'C002', name: 'Beta Fashion', inn: null, okved: '46.42', rev: null, prof: null, ru: 0, country: 'Германия', stand: 'B02' },
  { id: 'C003', name: 'Гамма Производство', inn: '5012345678', okved: '13.20', rev: 200, prof: 15, ru: 1, country: 'Россия', stand: 'C03' },
];

// ── Template existence ────────────────────────────────────────────────────────

describe('catalog-template/index.html', () => {
  it('template file exists', () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it('contains all required placeholders', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    for (const ph of ['{{EXPO_TITLE}}', '{{EVENT_KEY}}', '{{CATALOG_BASE}}', '{{FAVICON_EMOJI}}', '{{EX_JSON}}', '{{EXPO_DATE}}', '{{NOTES_API}}', '{{TG_BOT_USERNAME}}']) {
      expect(html, `Missing placeholder ${ph}`).toContain(ph);
    }
  });

  // Регрессия C1: адрес API заметок и бот были зашиты в шаблон, поэтому шаблон
  // и инструменты агента вели в разные места, а выключение старого воркера
  // (issue #19, шаг 11) уронило бы заметки на сайте молча.
  it('не зашивает ни Notes API, ни Telegram-бота в шаблон', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(html).not.toMatch(/workers\.dev/);
    expect(html).not.toContain('cmr_management_bot');
    expect(html).toContain('{{NOTES_API}}');
    expect(html).toContain('{{TG_BOT_USERNAME}}');
  });

  it('читает заметки по companyId с верхнего уровня ответа', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    // GET по одной компании отдаёт {ok, notes:[…]}, а не {company:{notes}}.
    expect(html).toContain('(p.notes||(p.company||{}).notes||[])');
  });

  it('обновляет статусы без перезагрузки страницы', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(html).toContain('function startStatusRefresh');
    expect(html).toContain('startStatusRefresh();');
  });

  it('has no lingerie-specific strings', () => {
    const html = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(html).not.toContain('lingerieshowforum2026');
    expect(html).not.toContain('lingerie-show-forum.ru');
    expect(html).not.toContain('Lingerie Show Forum');
  });
});

// ── expo_build_catalog ────────────────────────────────────────────────────────

describe('expo_build_catalog', () => {
  it('returns error when no enriched.json', async () => {
    const r = await expo_build_catalog.handler(
      { expo_id: 'nonexistent', event_key: 'test2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.error).toBeTruthy();
    expect(r.expo_id).toBe('nonexistent');
  });

  it('builds index.html with correct EVENT_KEY', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026', favicon_emoji: '🌸' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(existsSync(r.outputPath)).toBe(true);
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).toContain("'testexpo2026'");
    expect(html).toContain('Test Expo 2026');
    expect(html).toContain('🌸');
  });

  it('EX JSON injection — no double ]]; at end of array', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).not.toContain(']];');
    // EX array must end with ];
    const exMatch = html.match(/const EX = (\[[\s\S]*?\]);/);
    expect(exMatch).toBeTruthy();
    // valid JSON
    expect(() => JSON.parse(exMatch[1])).not.toThrow();
  });

  it('reports correct stats', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(r.stats.total).toBe(3);
  });

  // Собранный каталог и инструменты агента обязаны писать заметки в одно место.
  it('подставляет в HTML тот же Notes API, что используют инструменты', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain(r.notes_api);
    // Ровно тот же адрес, куда ходят flexi_add_note / flexi_get_notes.
    expect(r.notes_api).toBe(require('../../src/mcp-skills/notes-api.js').notesApiUrl());
  });

  it('уважает переопределение FLEXI_NOTES_API_URL в собранном HTML', async () => {
    const prev = process.env.FLEXI_NOTES_API_URL;
    process.env.FLEXI_NOTES_API_URL = 'https://notes.example.test/api/site-predeal-notes';
    try {
      makeEnriched(SAMPLE_COMPANIES);
      const r = await expo_build_catalog.handler(
        { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
        ctx()
      );
      expect(r.ok).toBe(true);
      expect(r.notes_api).toBe('https://notes.example.test/api/site-predeal-notes');
      expect(readFileSync(r.outputPath, 'utf8')).toContain('notes.example.test');
    } finally {
      if (prev === undefined) delete process.env.FLEXI_NOTES_API_URL;
      else process.env.FLEXI_NOTES_API_URL = prev;
    }
  });

  it('подставляет бота deep-link и не оставляет t.me-захардкоженным', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026', tg_bot: 'flexi_sales_bot' },
      ctx()
    );
    expect(r.ok).toBe(true);
    expect(r.tg_bot).toBe('flexi_sales_bot');
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).toContain("'flexi_sales_bot'");
    expect(html).toContain("'https://t.me/'+TG_BOT+'?start='");
  });

  // Валидатор в exhibitions раньше печатал «ALL OK», не проверяя ничего.
  // Сборка тоже не должна молча отдать битый каталог.
  it('падает на неподставленных плейсхолдерах, а не публикует «всё ок»', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const backup = readFileSync(TEMPLATE_PATH);
    writeFileSync(TEMPLATE_PATH, template.replace('{{NOTES_API}}', '{{NOTES_API_UNKNOWABLE}}'));
    try {
      const r = await expo_build_catalog.handler(
        { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
        ctx()
      );
      expect(r.error).toBeTruthy();
      expect(r.unresolved).toContain('NOTES_API_UNKNOWABLE');
    } finally {
      writeFileSync(TEMPLATE_PATH, backup);
    }
  });

  it('не собирает каталог из пустого набора данных', async () => {
    makeEnriched([]);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.ok).toBeFalsy();
    expect(r.error).toMatch(/нет ни одной компании/);
  });

  // Две компании на одном стенде делят id — «Создать сделку» для второй создаст
  // сделку первой. Настоящие значения из CPM Осень 2026 (13C18/13D19 — компания
  // на двух стендах, 13С11 — кириллическая «С», неотличимая от латинской).
  it('падает, когда у двух компаний один id', async () => {
    makeEnriched([
      { id: '13C56', name: '3W GREAT', inn: '7743421876', okved: '14.12', rev: 500, ru: 1, country: 'Россия', stand: '13C56' },
      { id: '13C56', name: 'СОСЕДНИЙ УЧАСТНИК', inn: '7709887766', okved: '14.12', rev: 100, ru: 1, country: 'Россия', stand: '13C56' },
    ]);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'cpmautumn2026', expo_title: 'CPM Осень 2026' },
      ctx()
    );
    expect(r.ok).toBeFalsy();
    expect(r.duplicate_ids[0].id).toBe('13C56');
    expect(r.error).toMatch(/повторов id/);
    expect(r.outputPath).toBeUndefined();
  });

  it('падает на id, который Telegram не передаст в ссылке', async () => {
    makeEnriched([
      { id: '13C18/13D19', name: 'ДВА СТЕНДА', inn: '7743421876', okved: '14.12', rev: 500, ru: 1, country: 'Россия', stand: '13C18/13D19' },
      { id: '13С11', name: 'КИРИЛЛИЧЕСКАЯ С', inn: '7709887766', okved: '14.12', rev: 100, ru: 1, country: 'Россия', stand: '13С11' },
    ]);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'cpmautumn2026', expo_title: 'CPM Осень 2026' },
      ctx()
    );
    expect(r.ok).toBeFalsy();
    expect(r.unsafe_ids.map(u => u.id).sort()).toEqual(['13C18/13D19', '13С11']);
    expect(r.error).toMatch(/непригодных для ссылки/);
  });

  it('accepts expo URL as expo_id', async () => {
    const slug = 'flowers-expo-ru-online-exhibitors-html';
    makeEnriched(SAMPLE_COMPANIES, slug);
    const r = await expo_build_catalog.handler(
      { expo_id: 'https://www.flowers-expo.ru/online/exhibitors.html', event_key: 'flowersexpo2026', expo_title: 'Flowers Expo 2026' },
      ctx()
    );
    expect(r.ok).toBe(true);
  });

  it('respects catalog_base placeholder', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo', catalog_base: 'https://myexpo.ru' },
      ctx()
    );
    const html = readFileSync(r.outputPath, 'utf8');
    expect(html).toContain('https://myexpo.ru');
    expect(html).not.toContain('{{CATALOG_BASE}}');
  });

  it('points publishing at site_deploy, not wrangler', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const r = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    expect(r.deploy).toEqual({ tool: 'site_deploy', dir: dirname(r.outputPath), project: 'test-expo' });
    expect(r.next_step).toContain('site_deploy(');
    expect(JSON.stringify(r)).not.toContain('wrangler');
  });
});

// ── expo_deploy_catalog ───────────────────────────────────────────────────────

describe('expo_deploy_catalog', () => {
  it('returns error when index.html missing', async () => {
    const r = await expo_deploy_catalog.handler({ expo_id: 'nonexistent' }, ctx());
    expect(r.error).toBeTruthy();
    expect(r.build_cmd).toBeTruthy();
  });

  it('hands a built catalog to site_deploy instead of running wrangler', async () => {
    makeEnriched(SAMPLE_COMPANIES);
    const built = await expo_build_catalog.handler(
      { expo_id: 'test-expo', event_key: 'testexpo2026', expo_title: 'Test Expo 2026' },
      ctx()
    );
    const r = await expo_deploy_catalog.handler({ expo_id: 'test-expo', project_name: 'testexpo2026-site' }, ctx());
    expect(r.published).toBe(false);
    expect(r.next_tool).toBe('site_deploy');
    expect(r.args).toEqual({ dir: dirname(built.outputPath), project: 'testexpo2026-site' });
    expect(JSON.stringify(r)).not.toContain('wrangler');
  });
});
