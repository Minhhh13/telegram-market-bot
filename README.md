# Telegram Market Bot

Standalone Telegram market reports for the TradeDesk group's **BINANCE P2P Rate** and **Notes** topics. The C5 SMS code bot and iPhone shortcut are separate and unchanged. This repository does not modify the Trade Desk or TouchLine applications.

## Live hosting

Two independent Edge Functions run in the existing TouchLine Supabase project. Supabase Cron and pg_net call them; encrypted credentials are held in Edge Function Secrets and Vault. GitHub Actions schedules have been removed. The Actions workflows remain available for manual fallback and previews.

| Update | Supabase schedule (UTC) | Sydney time during daylight saving |
| --- | --- | --- |
| Binance P2P USDT/VND | 27 * * * * | 27 minutes past every hour |
| CS2 charts | 37 22 * * * | 9:37 am daily |

Sydney's daily time becomes 8:37 am during standard time because the Cron expression is UTC. The code and schedules live in this bot repository and Supabase; no always-on server is needed. On Supabase Free, about 750 scheduled invocations a month is small compared with the published 500,000 monthly Edge Function invocation allowance, though all functions in the project share that allowance. Free projects can pause under Supabase's inactivity rules.

## Reports

- **Binance P2P:** red customer-sell and green customer-buy USDT/VND quotes, plus their midpoint. Telegram displays bold, color-marked lines. Only live offers able to fill 20,000,000 VND qualify; tiny or promoted-only orders do not determine the quote. Each invocation fetches up to three pages per side and sends one message.
- **CS2 daily charts:** an album of four 1200 × 1200 PNG cards for overall tracked market cap, BUFF163, YouPin898, and CSFloat listed inventory value. The source is CS2Cap's free public CSV export, not a paid CSMarketAPI endpoint. The private telegram_market_snapshots table stores daily readings; charts use the latest 90 for seven-day graphs and yesterday comparisons. Rolling source changes are labeled separately from saved daily comparisons. The function skips a second post for a day already marked as sent.

The chart function uses the WebAssembly build of resvg and two Inter fonts from version-pinned public CDN URLs. No paid market data or image rendering service is used. A source outage or layout change fails the run rather than posting stale numbers. These reports do not place trades.

## Source and deployment

- supabase/telegram-p2p-rate/index.ts — hourly rate Edge Function.
- supabase/telegram-marketcap/index.ts — daily chart Edge Function.
- supabase/SETUP.md — isolated table, secrets, and Vault-backed Cron SQL. Do not put credential values in source, SQL snippets, or this repository.
- src/ and .github/workflows/ — Node.js implementations and manual GitHub Actions fallback. Use Node.js 22+ for local preview; run npm ci then npm test to verify quote logic.

The live Supabase functions have legacy JWT verification enabled and also require a separate long random Cron key in a request header. The public table has row-level security enabled and no client policies; only the server-side function can read or write the snapshots. Supabase's cron.job_run_details, net._http_response, and Edge Function logs show timer, HTTP, and function failures.

Data sources: Binance P2P (https://p2p.binance.com/en/trade/sell/USDT?fiat=VND), CS2Cap (https://cs2cap.com/cs2-market-cap), Telegram Bot API (https://core.telegram.org/bots/api).


