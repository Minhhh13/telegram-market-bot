import { pathToFileURL } from 'node:url';
import { decimal, formatMessage, selectQuote } from './quotes.js';

const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const ROWS = 20;
const MAX_PAGES = 3;

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function readConfig(env = process.env) {
  const amountVnd = env.QUOTE_AMOUNT_VND?.trim() || '20000000';
  if (!/^\d+$/.test(amountVnd) || decimal(amountVnd).numerator <= 0n) {
    throw new Error('QUOTE_AMOUNT_VND must be a positive whole VND amount');
  }
  return {
    amountVnd,
    token: env.TELEGRAM_BOT_TOKEN?.trim(),
    chatId: env.TELEGRAM_CHAT_ID?.trim(),
    threadId: env.TELEGRAM_THREAD_ID?.trim(),
  };
}

async function fetchMarketPage(side, page, amountVnd, fetchImpl) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(BINANCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          page, rows: ROWS, payTypes: [], asset: 'USDT', fiat: 'VND',
          tradeType: side, transAmount: amountVnd, publisherType: null,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Market request failed');
      const body = await response.json();
      if (body?.code !== '000000' || body.success === false || !Array.isArray(body.data)) {
        throw new Error('Market response invalid');
      }
      return body.data;
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Binance ${side} quote feed unavailable after ${MAX_ATTEMPTS} attempts`);
      await pause(attempt * 750);
    }
  }
}

export async function fetchMarket(side, amountVnd, fetchImpl = fetch) {
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchMarketPage(side, page, amountVnd, fetchImpl);
    for (const row of data) {
      const id = row?.adv?.advNo;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(row);
    }
    if (data.length < ROWS) break;
  }
  return selectQuote(rows, side, amountVnd);
}

export async function getSnapshot(config, fetchImpl = fetch) {
  const [red, green] = await Promise.all([
    fetchMarket('SELL', config.amountVnd, fetchImpl),
    fetchMarket('BUY', config.amountVnd, fetchImpl),
  ]);
  const timestamp = new Date();
  return { red, green, timestamp: timestamp.toISOString(), message: formatMessage({ red, green, amountVnd: config.amountVnd, timestamp }) };
}

export async function sendTelegram(config, text, fetchImpl = fetch) {
  if (!config.token || !config.chatId) throw new Error('Sending requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  if (!/^-?\d+$/.test(config.chatId)) throw new Error('TELEGRAM_CHAT_ID must be a numeric chat ID');
  if (config.threadId && (!/^\d+$/.test(config.threadId) || !Number.isSafeInteger(Number(config.threadId)) || Number(config.threadId) <= 0)) {
    throw new Error('TELEGRAM_THREAD_ID must be a safe positive integer');
  }
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, ...(config.threadId ? { message_thread_id: Number(config.threadId) } : {}), text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Telegram delivery could not be confirmed. It may have arrived; this job will not retry and risk a duplicate.');
  }
  let body;
  try { body = await response.json(); } catch {
    throw new Error('Telegram returned an unreadable response; delivery status is unknown.');
  }
  if (!response.ok || body?.ok !== true) {
    const code = Number.isSafeInteger(body?.error_code) ? body.error_code : response.status;
    // Deliberately do not print remote descriptions or request URLs containing the bot token.
    throw new Error(`Telegram rejected delivery (error ${code}). Check the bot membership, permissions, chat ID and topic ID.`);
  }
  return { messageId: body.result?.message_id, chatId: body.result?.chat?.id };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--send', '--json']);
  if (args.some((argument) => !allowed.has(argument))) throw new Error('Usage: node src/index.js [--send] [--json]');
  const config = readConfig();
  if (args.includes('--send') && (!config.token || !config.chatId)) {
    throw new Error('Sending requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }
  const snapshot = await getSnapshot(config);
  if (args.includes('--send')) {
    const receipt = await sendTelegram(config, snapshot.message);
    console.log(JSON.stringify({ status: 'sent', timestamp: snapshot.timestamp, messageId: receipt.messageId }));
  } else {
    console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : snapshot.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
