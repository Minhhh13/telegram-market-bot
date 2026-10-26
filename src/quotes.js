const POW10 = (digits) => 10n ** BigInt(digits);

// Keep Binance's decimal strings exact, including available USDT quantities.
export function decimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Missing decimal');
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || match[1].length > 20 || (match[2]?.length ?? 0) > 18) throw new Error('Invalid decimal');
  const digits = match[2] ?? '';
  return { numerator: BigInt(match[1] + digits), denominator: POW10(digits.length) };
}

export function compare(left, right) {
  const delta = left.numerator * right.denominator - right.numerator * left.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function multiply(left, right) {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

export function roundHalfUp(value) {
  return (value.numerator * 2n + value.denominator) / (value.denominator * 2n);
}

export function midpoint(red, green) {
  const left = decimal(red);
  const right = decimal(green);
  return roundHalfUp({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: 2n * left.denominator * right.denominator,
  });
}

function normalizeAd(row, side, amount) {
  try {
    const ad = row?.adv;
    if (!ad || ad.asset !== 'USDT' || ad.fiatUnit !== 'VND' || ad.isTradable !== true) return null;
    // Request side is the customer's action, the advertisement is the opposite side.
    if (ad.tradeType !== (side === 'SELL' ? 'BUY' : 'SELL')) return null;
    const price = decimal(ad.price);
    if (compare(price, decimal('0')) <= 0 || compare(price, decimal('1000000000')) > 0) return null;
    const minimum = decimal(ad.minSingleTransAmount);
    const maximum = decimal(ad.maxSingleTransAmount);
    const dynamicMaximum = decimal(ad.dynamicMaxSingleTransAmount);
    const availableValue = multiply(decimal(ad.tradableQuantity), price);
    if (compare(minimum, amount) > 0) return null;
    if ([maximum, dynamicMaximum, availableValue].some((capacity) => compare(capacity, amount) < 0)) return null;
    return {
      adId: String(ad.advNo ?? ''),
      advertiser: String(row.advertiser?.nickName ?? 'Unknown'),
      price: String(ad.price),
      minimumVnd: String(ad.minSingleTransAmount),
      maximumVnd: String(ad.maxSingleTransAmount),
      availableMaximumVnd: String(ad.dynamicMaxSingleTransAmount),
      availableUsdt: String(ad.tradableQuantity),
      promoted: row.privilegeType === 1,
    };
  } catch {
    // Missing or malformed availability data must not turn into a quoted rate.
    return null;
  }
}

export function selectQuote(rows, side, amountVnd = '20000000') {
  if (!['SELL', 'BUY'].includes(side)) throw new Error('Invalid customer trade side');
  const amount = decimal(amountVnd);
  if (compare(amount, decimal('0')) <= 0) throw new Error('Quote amount must be positive');
  const candidates = rows.map((row) => normalizeAd(row, side, amount)).filter(Boolean);
  candidates.sort((a, b) => (side === 'SELL' ? -1 : 1) * compare(decimal(a.price), decimal(b.price)));
  if (!candidates.length) throw new Error(`No ${side} USDT offer can fill ${amountVnd} VND`);
  return { ...candidates[0], eligibleAds: candidates.length, inspectedAds: rows.length };
}

const formatInteger = (value) => new Intl.NumberFormat('en-US').format(value);

export function formatMessage({ red, green, amountVnd, timestamp = new Date() }) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(timestamp);
  return [
    '<b>BINANCE P2P · USDT/VND</b>',
    '',
    `🔴 <b>RED: ${formatInteger(roundHalfUp(decimal(red.price)))} VND</b>`,
    `🟢 <b>GREEN: ${formatInteger(roundHalfUp(decimal(green.price)))} VND</b>`,
    '',
    `🔵 <b>MIDPOINT: ${formatInteger(midpoint(red.price, green.price))} VND</b>`,
    '<i>(RED + GREEN) ÷ 2 · per 1 USDT</i>',
    '',
    `Offers able to fill ${formatInteger(BigInt(amountVnd))} VND`,
    `${time} ICT (UTC+7)`,
  ].join('\n');
}
