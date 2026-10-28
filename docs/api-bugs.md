# API Bugs & Limitations

Below are known issues with the Flexi/Weeek API and suggested workarounds.

## 1. `flexi_unreject_company` returns 400 "audio, noteText or statusAction is required"
The worker requires at least one of `audio`, `noteText`, or `statusAction`. Even when `statusAction: "unreject"` is passed internally, the tool implementation fails to pass it to the API call.
- **Workaround:** Currently blocked. Requires worker code fix.

## 2. `flexi_delete_note` returns 404 "Not found"
The API returns 404 regardless of whether `note_id` or `match` criteria are used.
- **Workaround:** Currently blocked. Requires investigation into the note deletion endpoint contract.

## 3. Weeek deal creation blocked
Requires `WEEEK_STATUS_OPTIONS_JSON` configuration on the `flexi-telegram-deal-bot` worker.
- **Fix:** Call `weeek_list_statuses({ funnel_id })` to collect status IDs, then configure the JSON mapping in the worker's environment variables.
