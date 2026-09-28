---
server: sales-skills
module: 85-expo.js
when: ready
---
## Exhibition catalog (Flexi)
Pipeline: `expo_find_participants(site_url)` (JS-rendered → fetch page → `expo_parse_participants(html)`) → `inn_enrich_batch` → `expo_classify_targets` → `expo_generate_ex_array` → write `b` descriptions for t:1/nt:1 ("Производство: [что], [город]. [1 фраза].") → build site from the latest exhibition template → `npx wrangler pages deploy SLUG --project-name SLUG` from exhibitions/exhibitions/.
- Target t:1: RU manufacturer (OKVED 13.x/14.x) + revenue 150–1000 млн (any profit) or 1–5 млрд (profit ≤100 млн). Near nt:1: RU manufacturer, revenue unknown/<150 млн/>5 млрд. Not: distributors/trade (OKVED 46.x+), foreign.
- Revenue filter ranges: always read `expo_pipeline_get_site_config`; change via `expo_pipeline_set_site_config`.
- New exhibition also needs: `EVENT_KEY='eventnameyear'` in JS, eventKey in flexi-telegram-deal-bot ALLOWED_ORIGINS + mapping, `telegram_companies.json`.
- EX array: bracket-matching only, never regex; write back `text[:start] + json.dumps(ex) + ';' + text[end+2:]`; must end `];` not `]];`. Commit on `feature/SLUG` before running.
- Where to save (paths relative to the profile workDir; moved from core's profile-layout skill, trained-assist-agent#1717): target requirements → `contexts/prompts/target_company_prompt.txt`; company card standard → `contexts/prompts/company_showcase_spec.txt`; exhibition deal → `contexts/exhibitions/{eventKey}/deals/{companyId}.json`; active exhibition → `contexts/flexi/active_exhibition.json`. Never write into the shared `flexi-consult` profile.
- Prompt read order: `contexts/prompts/<file>.txt` → `contexts/<file>.txt` (backward compat) → `$USERS_DIR/flexi-consult/site-requirements-target.md` / `site-requirements-display.md` (fallback).
