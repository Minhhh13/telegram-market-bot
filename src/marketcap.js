import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

export const SOURCE = 'https://cs2cap.com/cs2-market-cap';
const PLATFORMS = ['BUFF163', 'Youpin898', 'CSFloat'];
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field); field = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else if (c !== '\r' || quoted) field += c;
  }
  if (quoted) throw new Error('Invalid source CSV');
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header?.includes('section') || !header.includes('value')) throw new Error('Unknown source CSV schema');
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((key, i) => [key, r[i]])));
}

export function parseOverview(html, now = new Date()) {
  const tag = [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0]).find(s => /download="cs2cap-market-overview\.csv"/.test(s));
  const href = tag?.match(/href="(data:text\/csv[^"<]+)"/)?.[1]?.replaceAll('&amp;', '&');
  if (!href) throw new Error('CS2Cap public CSV export missing');
  const csv = decodeURIComponent(href.slice(href.indexOf(',') + 1));
  const rows = parseCsv(csv);
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try { const value = JSON.parse(m[1]); if (typeof value[1] === 'string') flight += value[1]; } catch { /* Ignore non-data records. */ }
  }
  const generatedAt = flight.match(/"generated_at"\s*:\s*"([^"]+)"/)?.[1];
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp) || timestamp > +now + 300000 || +now - timestamp > MAX_AGE_MS) {
    throw new Error('CS2Cap snapshot is stale or has no valid source timestamp');
  }
  const number = (row) => {
    const n = Number(row?.value);
    if (!Number.isFinite(n) || n <= 0 || n > 1e14) throw new Error('Missing or invalid market value');
    return n;
  };
  const globalRows = rows.filter(r => r.section === 'summary' && r.name === 'total_marketcap_usd');
  if (globalRows.length !== 1) throw new Error('Global market cap missing or duplicated');
  const platforms = PLATFORMS.map(name => {
    const matches = rows.filter(r => r.section === 'marketplace_listed_value' && r.name === name);
    if (matches.length !== 1) throw new Error(`Source data missing or duplicated for ${name}`);
    return { name: name === 'Youpin898' ? 'YouPin898' : name, valueUsd: number(matches[0]) };
  });
  return { source: SOURCE, generatedAt: new Date(timestamp).toISOString(), globalCapUsd: number(globalRows[0]), platforms };
}

const usd = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const time = date => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
export function caption(snapshot) {
  return ['CS2 daily market update (USD)', `Overall tracked market cap: ${usd(snapshot.globalCapUsd)}`, '',
    'Marketplace listed value (estimate):', ...snapshot.platforms.map(p => `${p.name}: ${usd(p.valueUsd)}`), '',
    `Source snapshot: ${time(snapshot.generatedAt)} Sydney`, 'Platform totals are listed inventory value, not separate global market caps.', snapshot.source].join('\n');
}

export function chart(snapshot) {
  const max = Math.max(...snapshot.platforms.map(p => p.valueUsd));
  const colors = ['#f4b942', '#7d77ff', '#5ac7b0'];
  const bars = snapshot.platforms.map((p, i) => {
    const y = 285 + i * 112;
    return `<text x="64" y="${y}" fill="#eff3fa" font-size="25">${p.name}</text><text x="936" y="${y}" fill="#eff3fa" font-size="25" text-anchor="end">${usd(p.valueUsd)}</text><rect x="64" y="${y + 20}" width="872" height="22" rx="11" fill="#273244"/><rect x="64" y="${y + 20}" width="${872 * p.valueUsd / max}" height="22" rx="11" fill="${colors[i]}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="730"><rect width="1000" height="730" rx="26" fill="#121b2b"/><g font-family="DejaVu Sans, Arial, sans-serif"><text x="64" y="65" fill="#9baec6" font-size="21" letter-spacing="3">CS2 DAILY MARKET</text><text x="64" y="125" fill="#f5f7fb" font-size="22">Overall tracked market cap</text><text x="64" y="190" fill="#ffffff" font-size="58" font-weight="bold">${usd(snapshot.globalCapUsd)}</text><text x="64" y="234" fill="#9baec6" font-size="19">MARKETPLACE LISTED VALUE · USD ESTIMATES</text>${bars}<text x="64" y="635" fill="#9baec6" font-size="18">Source: CS2Cap · Snapshot ${time(snapshot.generatedAt)} Sydney</text><text x="64" y="674" fill="#9baec6" font-size="17">Listed inventory totals differ from overall market capitalization.</text></g></svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
}

export async function fetchOverview(fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(SOURCE, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Source HTTP error');
      return parseOverview(await response.text());
    } catch (e) {
      if (attempt === 2) throw new Error(`Market-cap source unavailable: ${e.message}`);
      await new Promise(r => setTimeout(r, 750));
    }
  }
}

export async function sendPhoto(snapshot, png, env = process.env, fetchImpl = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^-?\d+$/.test(env.TELEGRAM_CHAT_ID || '') || !/^\d+$/.test(env.TELEGRAM_THREAD_ID || '')) throw new Error('Telegram token, group and Notes topic are required');
  const body = new FormData();
  body.set('chat_id', env.TELEGRAM_CHAT_ID); body.set('message_thread_id', env.TELEGRAM_THREAD_ID);
  body.set('caption', caption(snapshot)); body.set('photo', new Blob([png], { type: 'image/png' }), 'cs2-market.png');
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error('rejected');
    return data.result.message_id;
  } catch { throw new Error('Telegram photo delivery could not be confirmed; no retry was attempted to avoid duplicates'); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--send', '--json', '--image'].includes(a))) throw new Error('Usage: node src/marketcap.js [--send] [--json] [--image]');
  const snapshot = await fetchOverview();
  const png = args.includes('--image') || args.includes('--send') ? chart(snapshot) : null;
  if (args.includes('--image')) await writeFile('marketcap-preview.png', png);
  if (args.includes('--send')) console.log(JSON.stringify({ status: 'sent', messageId: await sendPhoto(snapshot, png) }));
  else console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : caption(snapshot));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
