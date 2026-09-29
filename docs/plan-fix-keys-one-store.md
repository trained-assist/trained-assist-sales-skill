# Fix plan: DaData/Checko keys split across 3 stores (#1885 ¶3)

## 1. Proposal

**Scenario:** A user saves their own DaData/Checko key via `inn_set_dadata_token` / `inn_set_checko_key`, then calls `dadata_suggest` or `checko_discover`. The tool reports "not configured" because the reader looks in a different file path than the writer wrote to. The user's key is silently ignored; the shared platform key (INN_DADATA_TOKEN env var) masks the problem on prod.

**What changes:** Unify all key readers (71-dadata, 72-checko, 40-company) to read from the single store `tokensRoot()/<u>/inn/config.json` — the same path `70-inn-enrichment.js` already writes to. Add user-key > platform-env precedence (matching 70's merge). Add read-only legacy fallbacks for backward compat. Fix hints to point to the correct setter.

**Why not simpler:** A "just change the reader path" would fix the immediate bug but leave the precedence inverted (platform env wins over user key) and would not fix company_* (40-company.js) which uses a third store. The minimal complete fix touches all three readers in one pass.

## 2. Design

### Files changed

| File | Change |
|---|---|
| `src/mcp-skills/tools/71-dadata.js` | Rewrite `readCreds()` to use `tokensRoot()/<u>/inn/config.json` with user>platform precedence + legacy fallbacks |
| `src/mcp-skills/tools/72-checko.js` | Rewrite `readKey()` same pattern |
| `src/mcp-skills/tools/40-company.js` | Rewrite `dadataTokenPath()`/`readDadataToken()` to read from unified store, legacy fallback to `agent-tokens/<u>/dadata` |
| `src/mcp-skills/tools/70-inn-enrichment.js` | No change (already writes to the right path) |
| `src/data-paths.js` | No change (already exports `tokensRoot()`) |
| `tests/unit/keys-one-store.test.js` | Extend with legacy-fallback + precedence tests |

### Unified reader contract (new pattern, mirrors 70-inn-enrichment.js `readConfig`)

```
1. Read unified store: tokensRoot()/<u>/inn/config.json  → user keys
2. Fall back to platform env vars (INN_DADATA_TOKEN, etc.) only if user key absent
3. Fall back to legacy paths (users/<u>/.inn-config.json, agent-tokens/<u>/dadata) read-only
```

Priority: **user key (unified store) > platform env > legacy fallback**. This matches 70's `{...platform, ...user}` merge.

### Data contract (unchanged)

- `inn_set_dadata_token` writes `{dadataToken, dadataSecret}` to unified store (unchanged).
- `inn_set_checko_key` writes `{checkoKey}` to unified store (unchanged).
- `company_set_dadata_token` writes to unified store `{dadataToken}` (was writing legacy `agent-tokens/<u>/dadata` — now writes to same store).
- All readers resolve from the same store.

### Why not a separate shared module

The three readers are small (15-20 lines each). Extracting a shared module adds a new file and a new import surface for marginal benefit. The fix is to align the three readers to the same path + precedence pattern, which is a 10-line change per reader.

## 3. Spec delta

No user-facing spec changes. The `inn_status` tool already reports `dadata`/`checko` origin as `user` or `platform` — this remains correct after the fix.

## 4. Slices (implementation steps)

### Slice 1: Fix 71-dadata.js `readCreds()`
- Replace `userWorkDir()/.inn-config.json` path with `tokensRoot()/<u>/inn/config.json`.
- Implement user>platform precedence: read unified store first, then env only if missing.
- Add legacy fallback: if unified store missing, try `users/<u>/.inn-config.json` (old path).
- Update error hints (lines 93, 120) — they already say `inn_set_dadata_token`, no change needed.

### Slice 2: Fix 72-checko.js `readKey()`
- Same pattern as Slice 1: unified store → env → legacy fallback.
- Update error hint (line 121) — already says `inn_set_checko_key`, no change needed.

### Slice 3: Fix 40-company.js `dadataTokenPath()` / `readDadataToken()`
- Change `dadataTokenPath()` to resolve via `tokensRoot()/<u>/inn/config.json` (read `dadataToken` field).
- Legacy fallback: if unified store has no `dadataToken`, try `agent-tokens/<u>/dadata` (plain file).
- `company_set_dadata_token` handler: write to unified store instead of legacy path.

### Slice 4: Extend regression test
- Add test: platform env key is used when no user key in unified store.
- Add test: user key in unified store overrides platform env.
- Add test: legacy `agent-tokens/<u>/dadata` fallback works for company_*.
- Add test: `company_set_dadata_token` writes to unified store and is readable by dadata_*.

## 5. Verification plan

| Step | Verification | Level |
|---|---|---|
| R5 (existing) | `npx vitest run tests/unit/keys-one-store.test.js` — 2 tests pass (were red) | S0 |
| Slice 1-3 | Rerun R5 — still pass after each slice | S0 |
| Slice 4 | New tests pass (precedence + legacy fallback) | S0 |
| Full suite | `npx vitest run` — no regressions in other test files | S1 |
| Manual smoke | Set key via inn_set_dadata_token → call dadata_suggest with real query → returns results | S2 |

## 6. Risks and rollback

**Risk: legacy fallback reads stale/malicious data from old paths.**
Mitigation: fallback is read-only and only used when unified store is absent. On prod, all users should have migrated to the unified store (it's been the writer's path since the tool existed). The fallback is a safety net, not a primary path.

**Risk: company_set_dadata_token changes where it writes.**
Mitigation: The new path is the same as what 70-inn-enrichment.js already uses. The old `agent-tokens/<u>/dadata` plain-file path is kept as a read fallback. No data migration needed.

**Rollback:** Each slice is a file edit. Revert by checking out the file from `d380993` (base revision). No migration or data change to undo.

**Radius of impact:** Only the sales-skill DaData/Checko/company tools. No other services or users affected. The fix is purely internal key resolution.
