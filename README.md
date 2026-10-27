# Telegram Market Bot

Standalone scheduled Telegram market reports. Runtime credentials and destination IDs are supplied through GitHub Actions secrets.

- **Binance P2P:** USDT/VND red customer-sell and green customer-buy quotes targeted once per hour. Telegram displays bold rates with red, green and blue markers for RED, GREEN and MIDPOINT. Only offers able to fill 20,000,000 VND qualify. The midpoint is `(RED + GREEN) / 2`. Offers are sorted by price after checking available volume and order limits.
- **CS2 daily charts:** one Telegram album of four large, square cards: overall tracked market cap, then separate BUFF163, YouPin898 and CSFloat listed-value estimates from CS2Cap's free public CSV export. Each card has labelled USD axes, dates, a seven-day graph, and color-coded 24h/7d change boxes. The overall card displays the source's published rolling 24h/7d trend immediately when available; marketplace 24h/7d comparisons use actual saved daily snapshots. Missing comparisons say **Collecting**. Graph points also require actual saved snapshots. Platform listed values are not separate ecosystem market caps. No CSMarketAPI key or paid market-data subscription is required.

Requires Node.js 22+; hosted jobs use Node.js 24. Run `npm ci`, `npm test`, then `node src/index.js` or `node src/marketcap.js --image` for read-only previews. Explicit `--send` is required to post.

## Hosting

Standard GitHub-hosted Linux runners in a public repository run without paid Actions minutes. No artifact storage or cache is used. Scheduled workflows can be delayed or dropped by GitHub, so exact hourly delivery cannot be guaranteed. The Binance workflow has two opportunities each hour and checks the preceding successful scheduled runs; it skips Binance requests and Telegram posting if a quote was sent within 50 minutes. Daily snapshots are saved in `data/market-history.json` by the daily workflow, using write permission scoped to this repository. The last 90 snapshots are retained and each card displays the last seven calendar days. History begins when this bot is installed; no historical values are invented. The first actual day-to-day comparison requires a snapshot from yesterday; marketplace 7d change requires a snapshot from seven days earlier.

Jobs use temporary `ubuntu-latest` runners, with no always-on server. The hourly P2P job uses only Node.js built-ins and runs the quote safeguards without installing npm dependencies. Each successful quote run fetches at most three pages per side and sends one Telegram message. Only the daily chart job installs the PNG renderer. Each job has a five-minute timeout.

The P2P cron is `17,47 * * * *` (17 and 47 minutes past each hour, UTC). The CS2 cron is `37 22 * * *` (daily at 09:37 Sydney during daylight saving, 08:37 during standard time). Manual dispatch previews by default; check **send** only when a delivery is intended. The four CS2 cards are rendered from one page fetch per successful daily run; source fetch failures can cause up to three attempts. Redisplaying a saved card does not fetch the source again. CS2Cap's paid API quota is not involved in this public-page export approach.

Configure encrypted repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| TELEGRAM_BOT_TOKEN | The market update bot credential |
| TELEGRAM_CHAT_ID | Numeric destination group ID |
| TELEGRAM_THREAD_ID | P2P rates topic ID |
| NOTES_THREAD_ID | Daily CS2 chart topic ID |

After a successful preview and delivery test, set repository Actions variables `SCHEDULE_ENABLED` and `MARKETCAP_SCHEDULE_ENABLED` to `true`. No scheduled jobs run until enabled. Tests and previews do not receive bot secrets.

The bot does not place trades. Market sources are independently operated and can change their schemas or restrict cloud access. It sends no stale, incomplete or substituted figures. A failed run is visible in Actions; Telegram posts are not retried on ambiguous delivery to avoid duplicates.

Data sources: [Binance P2P](https://p2p.binance.com/en/trade/sell/USDT?fiat=VND), [CS2Cap market overview](https://cs2cap.com/cs2-market-cap), [Telegram Bot API](https://core.telegram.org/bots/api).
