# trained-assist-sales-skill

Sales / CRM domain skill of [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) (epic #1470).
Mounted by core as the `sales-skills` MCP sibling: core's `deploy.sh` checks it out next to the
release (after the MCP contract check), `src/browser.js` adds it to each session's `.mcp.json`,
and core reads `src/prompt-domains/*.md` for the prompt rules.

## Contents
- `30-weeek.js` — Weeek CRM (deals, contacts, tasks, comments)
- `85-expo.js` … `89-expo-pipeline-run.js`, `92-flexi-sales.js` — exhibition participants → targets → sales catalog (Flexi); `expo-paths.js`, `src/catalog-template/`
- `40-company.js`, `70-inn-enrichment.js` (+ `src/inn-pipeline/`), `71-dadata.js`, `72-checko.js` — company / INN data (also used by recruiting)
- `src/prompt-domains/` — `weeek`, `weeek.setup`, `expo`, `flexi-sales`
- `playbooks/exhibition-catalog-to-sales-site.json` — единый плейбук продаж на выставке
  (гейты → пайплайн «ссылка → сайт» → приёмка → сделки из визитки → рабочий цикл → ограничения).
  Core резолвит его как sibling-плейбук (нужен `trained-assist-sales-skill` в
  `DEFAULT_SIBLING_REPOS`, trained-assist-agent#1728); контракт проверяет
  `scripts/check-playbook-contract.js` в CI.

Profile skills: core's catalog addresses these modules as `sales-skills/<file>`; the registry
skips modules listed in `SKILLS_RESOLVED` → `hidden.modules`.

Scheduling: `expo_pipeline_run auto_cron` reports "schedules unavailable" until core's
cron-service lands (trained-assist-agent#1489); then use core's provider jobs API.

## Develop
```bash
npm run check   # every tool module loads
npm test        # offline unit tests
```
Credentials stay on the platform side: the Weeek token is collected by core (`/connect/weeek`,
`/settoken weeek`) into `~/agent-tokens/<profile>/weeek`; this skill only reads it.

## Claude Code Instructions
- One copy of the domain code lives here; core must not keep copies.
- Tool files export `{ tools, isReady?, setupTools? }`; keep tool names stable (core prompts refer to them).
- Every outbound HTTP call needs a timeout; token files are written with mode `0o600`.
