# trained-assist-sales-skill

Sales/CRM и company/INN domain capabilities. Одна бизнес-реализация используется платформенными adapters; наличие инструмента не разрешает отправку/мутацию без scope и effect policy.

Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

## Sources

- `src/mcp-skills/tools/` — Weeek, company/INN, DaData/Checko и exhibition/Flexi tools.
- `src/prompt-domains/` — scoped domain instructions.
- `playbooks/exhibition-catalog-to-sales-site.json` — доменный playbook artifact.

Host supplies authenticated profile, credential binding, paths/artifact refs and capability eligibility. Compatibility file-store readers remain source-defined; they are not permission to expose host credentials to a Run. Scheduler availability is checked via the configured backend, not an old issue's “lands later” claim.


Credential readers/writers for company/INN, DaData and Checko share `src/mcp-skills/inn-keys.js`. A user's configured key takes precedence over the platform fallback; legacy reads remain compatibility-only. Setter → reader interoperability and precedence are covered by `tests/unit/keys-one-store.test.js`.

```bash
npm run check
npm test
```

Do not duplicate this domain in core or create two implementations for UI/MCP. API/UI access and run-local tools follow [shared boundaries](https://github.com/trained-assist/trained-agent-architecture/blob/main/ARCHITECTURE.md). Plans/status: [issues](https://github.com/trained-assist/trained-assist-sales-skill/issues).

Retiring GCP VM is not a development or fallback target. Choose hosting per service architecture and owning decision. HH cold-search hosting and sequencing are tracked in https://github.com/trained-assist/trained-agent-architecture/issues/187, under the architecture exit plan at https://github.com/trained-assist/trained-agent-architecture/issues/145; do not assume a French VM or serverless target. Other Google services remain allowed.
