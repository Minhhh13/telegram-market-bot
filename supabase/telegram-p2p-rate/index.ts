// Standalone Supabase Edge Function. Its secrets live in Supabase, not in source.
// The HTTP endpoint accepts only POST requests with the private P2P_CRON_KEY.

const BINANCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const REQUEST_TIMEOUT_MS = 15_000;
const AMOUNT_VND = '20000000';
const ROWS_PER_PAGE = 20;
const MAX_PAGES = 3;
const MAX_ATTEMPTS = 3;

type Env = Record<string, string | undefined>;
type Quote = { price: string };
type AdRow = {
  adv?: {
    advNo?: string;
    asset?: string;
    fiatUnit?: string;
    isTradable?: boolean;
    tradeType?: string;
    price?: string;
    minSingleTransAmount?: string;
    maxSingleTransAmount?: string;
    dynamicMaxSingleTransAmount?: string;
    tradableQuantity?: string;
  };
  privilegeType?: number;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const decimal = (value: unknown) => {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Missing decimal');
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || match[1].length > 20 || (match[2]?.length ?? 0) > 18) throw new Error('Invalid decimal');
  const digits = match[2] ?? '';
  return { numerator: BigInt(match[1] + digits), denominator: 10n ** BigInt(digits.length) };
};
type Decimal = ReturnType<typeof decimal>;
const compare = (a: Decimal, b: Decimal) => {
  const delta = a.numerator * b.denominator - b.numerator * a.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
const roundHalfUp = (value: Decimal) => (value.numerator * 2n + value.denominator) / (value.denominator * 2n);
const formatInteger = (value: bigint) => new Intl.NumberFormat('en-US').format(value);

function eligibleAd(row: AdRow, side: 'SELL' | 'BUY') {
  try {
    const ad = row.adv;
    if (!ad || ad.asset !== 'USDT' || ad.fiatUnit !== 'VND' || ad.isTradable !== true) return null;
    if (ad.tradeType !== (side === 'SELL' ? 'BUY' : 'SELL')) return null;
    const amount = decimal(AMOUNT_VND);
    const price = decimal(ad.price);
    if (compare(price, decimal('0')) <= 0 || compare(price, decimal('1000000000')) > 0) return null;
    if (compare(decimal(ad.minSingleTransAmount), amount) > 0) return null;
    if (compare(decimal(ad.maxSingleTransAmount), amount) < 0) return null;
    if (compare(decimal(ad.dynamicMaxSingleTransAmount), amount) < 0) return null;
    const available = decimal(ad.tradableQuantity);
    if (compare({ numerator: available.numerator * price.numerator, denominator: available.denominator * price.denominator }, amount) < 0) return null;
    return { price: String(ad.price), adId: String(ad.advNo ?? ''), promoted: row.privilegeType === 1 };
  } catch {
    return null;
  }
}

async function fetchPage(side: 'SELL' | 'BUY', page: number, fetchImpl: typeof fetch) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(BINANCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ page, rows: ROWS_PER_PAGE, payTypes: [], asset: 'USDT', fiat: 'VND', tradeType: side, transAmount: AMOUNT_VND, publisherType: null }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Binance request failed');
      const body = await response.json();
      if (body?.code !== '000000' || body.success === false || !Array.isArray(body.data)) throw new Error('Invalid Binance response');
      return body.data as AdRow[];
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Binance ${side} feed unavailable`);
      await pause(attempt * 750);
    }
  }
  throw new Error(`Binance ${side} feed unavailable`);
}

async function quote(side: 'SELL' | 'BUY', fetchImpl: typeof fetch): Promise<Quote> {
  const candidates: ReturnType<typeof eligibleAd>[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await fetchPage(side, page, fetchImpl);
    for (const row of rows) {
      const id = row.adv?.advNo;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      candidates.push(eligibleAd(row, side));
    }
    if (rows.length < ROWS_PER_PAGE) break;
  }
  const valid = candidates.filter((item): item is NonNullable<typeof item> => item !== null);
  valid.sort((a, b) => (side === 'SELL' ? -1 : 1) * compare(decimal(a.price), decimal(b.price)));
  if (!valid.length) throw new Error(`No ${side} offer can fill ${AMOUNT_VND} VND`);
  return valid[0];
}

function message(red: Quote, green: Quote, now: Date) {
  const midpoint = roundHalfUp({
    numerator: decimal(red.price).numerator * decimal(green.price).denominator + decimal(green.price).numerator * decimal(red.price).denominator,
    denominator: 2n * decimal(red.price).denominator * decimal(green.price).denominator,
  });
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return [
    '<b>BINANCE P2P · USDT/VND</b>', '',
    `🔴 <b>RED: ${formatInteger(roundHalfUp(decimal(red.price)))} VND</b>`,
    `🟢 <b>GREEN: ${formatInteger(roundHalfUp(decimal(green.price)))} VND</b>`, '',
    `🔵 <b>MIDPOINT: ${formatInteger(midpoint)} VND</b>`,
    '<i>(RED + GREEN) ÷ 2 · per 1 USDT</i>', '',
    `Offers able to fill ${formatInteger(BigInt(AMOUNT_VND))} VND`,
    `${time} ICT (UTC+7)`,
  ].join('\n');
}

function equalSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function handleRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const key = env.P2P_CRON_KEY?.trim();
  if (!key || key.length < 32) return new Response('Server not configured', { status: 503 });
  if (!equalSecret(request.headers.get('x-p2p-cron-key') ?? '', key)) return new Response('Forbidden', { status: 403 });
  const token = env.P2P_TELEGRAM_TOKEN?.trim();
  const chatId = env.P2P_CHAT_ID?.trim();
  const threadId = env.P2P_THREAD_ID?.trim();
  if (!token || !chatId || !/^-?\d+$/.test(chatId) || !threadId || !/^\d+$/.test(threadId)) {
    return new Response('Server not configured', { status: 503 });
  }
  try {
    const [red, green] = await Promise.all([quote('SELL', fetchImpl), quote('BUY', fetchImpl)]);
    const telegram = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_thread_id: Number(threadId), text: message(red, green, new Date()), parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await telegram.json();
    if (!telegram.ok || body?.ok !== true) throw new Error('Telegram rejected delivery');
    return Response.json({ ok: true, message_id: body.result?.message_id });
  } catch {
    // Never log remote response bodies or URLs: the Telegram URL contains the bot token.
    console.error('P2P quote delivery failed');
    return Response.json({ ok: false, error: 'Quote delivery failed' }, { status: 502 });
  }
}

if (typeof Deno !== 'undefined') {
  Deno.serve((request: Request) => handleRequest(request, Deno.env.toObject()));
}

