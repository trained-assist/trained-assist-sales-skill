---
server: sales-skills
module: 92-flexi-sales.js
when: ready
---
## Flexi sales at exhibitions
- `flexi_set_active_exhibition(event_key)` once (e.g. rosupack2026) — persists in context.
- Notes: `flexi_add_note(company_name, note_text, stand?)` → D1, visible on {eventKey}-floorplans-2026.pages.dev. Read: `flexi_get_notes` / `flexi_get_notes_bulk`. Reject/undo: `flexi_reject_company` / `flexi_unreject_company`.
- company_id is the id from the exhibition data, NOT the stand. A stand may host several companies (129 duplicate ids in CPM) and may be missing or written with Cyrillic letters. Stand goes in the `stand` field.
- Deals from a catalog card: `flexi_deal_from_catalog(payload)` where payload is the deep-link `<eventKey>_deal_<companyId>`. Company ids in real catalogs are alphanumeric (`13C56`, `LNG001`, `OL001`, hex ids) — never assume numeric.
- `flexi_deal_from_catalog` requires `contact_name` (not in exhibition data — ask the visitor's contact, then call again with the same payload plus `contact_name`). If the data has no INN, pass `company_inn` too. On success it returns `deal_id` and `site_status: synced`.
- Repeats never create a second deal: the same card returns the same `deal_id`, and an unfinished operation returns `DEAL_CREATE_IN_PROGRESS`. `DEAL_CREATE_OUTCOME_UNKNOWN` means the Weeek response was lost — check `weeek_list_deals` before retrying.
- `flexi_sync_deal_status(event_key?, company_id?)` re-writes the "deal" status on the site for already-created deals. It never creates deals. Call it after `site_status: sync_failed` or to close leftovers after a restart.
- Rejection on a card blocks deal creation; `hasDeal` on the site blocks it too.
- Weeek deals are created with `weeek_create_deal`; other flexi_* tools only manage notes/status.