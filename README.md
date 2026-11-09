# Market Update Bot

Standalone market reports for Discord's **binance-p2p-usdt-rate** and **cs-market-update** channels, with the existing Telegram topics retained as a fallback. The C5 SMS code bot, skin price checker and iPhone shortcut are separate and unchanged. This repository does not modify the Trade Desk or TouchLine applications.

## Live hosting

Two independent Edge Functions run in the existing TouchLine Supabase project. Supabase Cron and pg_net call them; encrypted credentials are held in Edge Function Secrets and Vault. GitHub Actions schedules have been removed. The Actions workflows remain available for manual fallback and previews.

| Update | Supabase schedule (UTC) | Sydney time during daylight saving |
| --- | --- | --- |
| Binance P2P USDT/VND | 27 * * * * | 27 minutes past every hour |
| CS2 charts | 37 22 * * * | 9:37 am daily |

Sydney's daily time becomes 8:37 am during standard time because the Cron expression is UTC. The code and schedules live in this bot repository and Supabase; no always-on server is needed. On Supabase Free, about 750 scheduled invocations a month is small compared with the published 500,000 monthly Edge Function invocation allowance, though all functions in the project share that allowance. Free projects can pause under Supabase's inactivity rules.

## Reports

- **Binance P2P:** red customer-sell and green customer-buy USDT/VND quotes, plus their midpoint, with bold, color-marked lines. Only live offers able to fill 20,000,000 VND qualify; tiny or promoted-only orders do not determine the quote. Each invocation fetches up to three pages per side and sends one message.
- **CS2 daily charts:** an album of four 1200 × 1200 PNG cards for overall tracked market cap, BUFF163, YouPin898, and CSFloat listed inventory value. The source is CS2Cap's free public CSV export, not a paid CSMarketAPI endpoint. The private telegram_market_snapshots table stores daily readings; charts use the latest 90 for seven-day graphs and yesterday comparisons. Rolling source changes are labeled separately from saved daily comparisons. The function skips a second post for a day already marked as sent.

The chart function uses the WebAssembly build of resvg and two Inter fonts from version-pinned public CDN URLs. No paid market data or image rendering service is used. A source outage or layout change fails the run rather than posting stale numbers. These reports do not place trades.

## Discord migration

Create one incoming webhook in each destination channel. Save its full URL in encrypted Edge Function secrets:

| Secret | Discord channel | Channel ID |
| --- | --- | --- |
| P2P_DISCORD_WEBHOOK_URL | binance-p2p-usdt-rate | 1569204810664902707 |
| MARKETCAP_DISCORD_WEBHOOK_URL | cs-market-update | 1569204874803937381 |

Guild: `298758299317305344`. A webhook can post only in its own channel. Once a feed's webhook is configured, that feed sends only to Discord; an absent webhook retains its previous Telegram destination. A malformed or rejected webhook fails the run instead of silently posting elsewhere. The same existing cron jobs run, with no additional bot process or server.

Discord receives the complete P2P text or one message containing the market caption and four PNG charts. Delivery uses `wait=true` and requires Discord's message receipt. Pings and link previews are disabled. Sending is not automatically retried after a timeout because the first request may already have arrived. Daily receipts are tracked per webhook in the existing JSONB history column, preserving old Telegram receipts without a table migration.

Manual GitHub Actions fallback uses repository secrets with the same two webhook names. Configure those as well before using the fallback, or it will retain Telegram routing. Do not enable an additional Actions schedule alongside Supabase.

## Source and deployment

- supabase/telegram-p2p-rate/index.ts — hourly rate Edge Function.
- supabase/telegram-marketcap/index.ts — daily chart Edge Function.
- supabase/SETUP.md — isolated table, secrets, and Vault-backed Cron SQL. Do not put credential values in source, SQL snippets, or this repository.
- supabase/_shared/ — shared Discord delivery and daily receipt compatibility code. Include these files when deploying the source functions. For the Dashboard single-file editor, run `npm run bundle:edge` and paste the matching generated `.deploy/*.ts` file instead; bundles contain no secrets and retain pinned renderer imports.
- src/ and .github/workflows/ — Node.js implementations and manual GitHub Actions fallback. Use Node.js 22.18+ for local preview (built-in TypeScript stripping); run npm ci then npm test to verify quote logic.

The live Supabase functions have legacy JWT verification enabled and also require a separate long random Cron key in a request header. The public table has row-level security enabled and no client policies; only the server-side function can read or write the snapshots. Supabase's cron.job_run_details, net._http_response, and Edge Function logs show timer, HTTP, and function failures.

`npm test` verifies selection, safeguards and both transports with mocked deliveries. With Deno available, `npm run test:edge` also exercises the actual daily Edge handler and pinned WASM renderer against mocked source, database and destinations. Only pinned chart assets are downloaded; the test posts no public messages. The pre-existing daily function uses untyped JavaScript syntax in a `.ts` file, so this runtime check uses `--no-check`; the typed P2P bundle also passes `deno check`.

Data sources: Binance P2P (https://p2p.binance.com/en/trade/sell/USDT?fiat=VND), CS2Cap (https://cs2cap.com/cs2-market-cap). Delivery APIs: Discord incoming webhooks (https://docs.discord.com/developers/resources/webhook), Telegram Bot API (https://core.telegram.org/bots/api).


