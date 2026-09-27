# trained-assist-sales-skill

Sales / CRM domain skill of [trained-assist-agent](https://github.com/trained-assist/trained-assist-agent) (epic #1470).
Mounted by core as the `sales-skills` MCP sibling: core's `deploy.sh` checks it out next to the
release (after the MCP contract check), `src/browser.js` adds it to each session's `.mcp.json`,
and core reads `src/prompt-domains/*.md` for the prompt rules.

## Contents
- `src/mcp-skills/tools/30-weeek.js` — Weeek CRM (deals, contacts, tasks, comments); moved from core.
- `src/prompt-domains/weeek.md`, `weeek.setup.md` — prompt rules (gated by the module's readiness).

Next (planned): expo / Flexi sales pipeline, then company/INN data tools.

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
