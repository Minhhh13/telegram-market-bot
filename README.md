# Telegram Market Bot

Standalone scheduled Telegram market reports. Runtime credentials and destination IDs are supplied through GitHub Actions secrets.

- **Binance P2P:** USDT/VND red customer-sell and green customer-buy quotes every six hours. Only offers able to fill 20,000,000 VND qualify. The midpoint is `(RED + GREEN) / 2`. Offers are sorted by price after checking available volume and order limits.
- **CS2 daily chart:** overall tracked market cap and separate BUFF163, YouPin898 and CSFloat listed-value estimates from CS2Cap's free public CSV export. Green/red line charts show daily trends, and captions compare against the previous calendar day's saved snapshot. Platform listed values are not separate ecosystem market caps. No CSMarketAPI key or paid market-data subscription is required.

Requires Node.js 22+; hosted jobs use Node.js 24. Run `npm ci`, `npm test`, then `node src/index.js` or `node src/marketcap.js --image` for read-only previews. Explicit `--send` is required to post.

## Hosting

Standard GitHub-hosted Linux runners in a public repository run without paid Actions minutes. No artifact storage or cache is used. Scheduled workflows can be delayed by GitHub. Daily snapshots are saved in `data/market-history.json` by the daily workflow, using write permission scoped to this repository. The last 90 snapshots are retained and the chart displays up to 30 daily points. History begins when this bot is installed; no historical values are invented. The first actual day-to-day comparison requires a snapshot from yesterday.

The P2P cron is `17 */6 * * *` (UTC). The CS2 cron is `37 22 * * *` (daily at 09:37 Sydney during daylight saving, 08:37 during standard time). Manual dispatch previews by default; check **send** only when a delivery is intended.

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
