# Discord market updates — deployment handover

Deployed on 9 November 2026 to the existing TouchLine Supabase project (`yvqpmyqomkwtudxmkeou`). Each report now uses its own channel-scoped Discord incoming webhook. The existing Supabase functions, schedules, source feeds and history table are retained; no new server or recurring job is required.

| Feed | Discord channel | Channel ID | Existing function | Schedule (UTC) |
| --- | --- | --- | --- | --- |
| Binance USDT/VND | binance-p2p-usdt-rate | 1569204810664902707 | telegram-p2p-rate | `27 * * * *` |
| CS2 market charts | cs-market-update | 1569204874803937381 | telegram-marketcap | `37 22 * * *` |

Discord guild: `298758299317305344`. The daily schedule is 9:37 am Sydney during daylight saving and 8:37 am during standard time. The hourly report runs 27 minutes past the hour.

## Configuration and delivery

Encrypted Edge secrets `P2P_DISCORD_WEBHOOK_URL` and `MARKETCAP_DISCORD_WEBHOOK_URL` select the corresponding Discord destination. The configured feed delivers only to Discord. An absent webhook retains the previous Telegram destination; an invalid webhook fails without falling back elsewhere. Webhook URLs and private cron keys must remain outside source control.

Both functions retain **Verify JWT with legacy secret** enabled. Existing Cron/Vault authorization remains intact: legacy anon JWT in `Authorization: Bearer ...` and `apikey`, plus the corresponding `x-p2p-cron-key` or `x-marketcap-cron-key`. No JWT, Vault, database schema, or schedule change was part of this migration.

P2P sends one fresh text quote. The market report sends its complete caption and four ordered PNG charts in one confirmed Discord message. Delivery disables pings and link previews. Daily receipts are tracked per webhook in the existing `telegram_market_snapshots.message_ids` JSONB column, preserving previous Telegram receipts and preventing a second daily Discord report.

## Verification

- 38 Node tests passed; independent review found no required changes.
- The P2P bundle passed Deno type checking.
- Both the actual daily Edge handler and generated deployment bundle passed a real Deno/WASM smoke check using mocked source, database and outgoing deliveries.
- Both deployed Dashboard editor contents matched the prepared bundles. The original live functions matched the previous repository source apart from line endings and trailing whitespace.
- Live market preview request `329` returned HTTP 200 with all four rendered PNGs. Live delivery request `330` returned HTTP 200 and Discord message `1569213512323043378`.
- Live P2P request `331` returned HTTP 200 with platform `discord`, message `1569213876971511841` and the expected Binance channel ID. The visible channel post confirmed one 20,000,000 VND quote, with red 25,948, green 25,950 and midpoint 25,949 VND per USDT. No duplicate manual P2P send was made.

The Dashboard deployment used the self-contained files produced by `npm run bundle:edge`; shared helpers remain the tracked source of truth. For future releases, include those imports or regenerate the bundles before deploying.

Inspect existing Cron runs, Edge invocations, `net._http_response` receipts and the latest daily history row to check operation. A successful Cron run only confirms that the HTTP request was queued. Check the target channel before retrying an ambiguous P2P send, because a timed-out request may already have arrived and P2P has no durable per-run duplicate guard.

The manual GitHub Actions workflows remain unscheduled. Their optional Discord fallback requires repository secrets with the same webhook names; do not enable a second recurring schedule alongside Supabase.
