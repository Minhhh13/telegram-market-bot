import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
export const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
export function recordSnapshot(history, snapshot) {
  const valid = Array.isArray(history) ? history.filter(s => s?.source === SOURCE && Number.isFinite(Date.parse(s.generatedAt)) && Number.isFinite(s.globalCapUsd) && s.globalCapUsd > 0 && s.platforms?.length === 3 && s.platforms.every(p => Number.isFinite(p.valueUsd) && p.valueUsd > 0)) : [];
  const date = dayKey(snapshot.generatedAt);
  const prior = valid.find(s => dayKey(s.generatedAt) === date);
  if (prior && Date.parse(prior.generatedAt) > Date.parse(snapshot.generatedAt)) return valid;
  return [...valid.filter(s => dayKey(s.generatedAt) !== date), snapshot].sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt)).slice(-90);
}
export function yesterday(history, snapshot) {
  const date = new Date(`${dayKey(snapshot.generatedAt)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  const key = date.toISOString().slice(0, 10);
  return history.find(s => dayKey(s.generatedAt) === key);
}
export const changePct = (value, previous) => previous > 0 ? (value / previous - 1) * 100 : null;
const delta = value => value == null ? 'recording history' : `${value > 0 ? '+' : ''}${value.toFixed(2)}% vs yesterday`;
export function caption(snapshot, history = []) {
  const prev = yesterday(history, snapshot);
  return ['CS2 daily market update (USD)', `Overall tracked market cap: ${usd(snapshot.globalCapUsd)} (${delta(changePct(snapshot.globalCapUsd, prev?.globalCapUsd))})`, '',
    'Marketplace listed value (estimate):', ...snapshot.platforms.map(p => `${p.name}: ${usd(p.valueUsd)} (${delta(changePct(p.valueUsd, prev?.platforms.find(v => v.name === p.name)?.valueUsd))})`), '',
    `Source snapshot: ${time(snapshot.generatedAt)} Sydney`, 'Platform totals are listed inventory value, not separate global market caps.', snapshot.source].join('\n');
}

export function chart(snapshot, history = []) {
  const points = recordSnapshot(history, snapshot).slice(-30);
  const prev = yesterday(history, snapshot);
  const series = [{ name: 'Overall tracked market cap', value: snapshot.globalCapUsd, previous: prev?.globalCapUsd, values: points.map(s => s.globalCapUsd) },
    ...snapshot.platforms.map(p => ({ name: `${p.name} · listed value`, value: p.valueUsd, previous: prev?.platforms.find(v => v.name === p.name)?.valueUsd, values: points.map(s => s.platforms.find(v => v.name === p.name)?.valueUsd) }))];
  const panels = series.map((s, i) => {
    const y = 108 + i * 248, change = changePct(s.value, s.previous);
    const color = change == null ? '#8eacff' : change > 0 ? '#4dd5a5' : change < 0 ? '#fb7085' : '#9baec6';
    const values = s.values.filter(Number.isFinite), lo = Math.min(...values), hi = Math.max(...values), range = hi - lo || hi * 0.02;
    const coordinates = s.values.map((v, n) => ({ x: 64 + (s.values.length === 1 ? 0 : n / (s.values.length - 1) * 872), y: y + 163 - ((v - lo) / range) * 90 }));
    const path = coordinates.map((p, n) => `${n ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const line = coordinates.length > 1 ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>` : `<text x="100" y="${y + 163}" fill="#9baec6" font-size="20">Daily history begins today</text>`;
    const last = coordinates.at(-1);
    return `<text x="64" y="${y}" fill="#d6e0f0" font-size="23">${s.name}</text><text x="64" y="${y + 48}" fill="#fff" font-size="37" font-weight="bold">${usd(s.value)}</text><text x="936" y="${y + 48}" fill="${color}" font-size="21" text-anchor="end">${delta(change)}</text><path d="M64,${y + 185}H936 M64,${y + 100}H936" stroke="#28364b" stroke-width="1"/>${line}<circle cx="${last.x}" cy="${last.y}" r="5" fill="${color}"/><text x="64" y="${y + 211}" fill="#8fa3bd" font-size="16">${dayKey(points[0].generatedAt)}</text><text x="936" y="${y + 211}" fill="#8fa3bd" font-size="16" text-anchor="end">${dayKey(points.at(-1).generatedAt)}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1225"><rect width="1000" height="1225" rx="26" fill="#121b2b"/><g font-family="DejaVu Sans, Arial, sans-serif"><text x="64" y="54" fill="#9baec6" font-size="21" letter-spacing="3">CS2 DAILY TRENDS · USD</text>${panels}<text x="64" y="1136" fill="#9baec6" font-size="17">Green = up · Red = down · Daily snapshots · Each chart has its own scale</text><text x="64" y="1170" fill="#9baec6" font-size="16">CS2Cap · Snapshot ${time(snapshot.generatedAt)} Sydney</text><text x="64" y="1200" fill="#9baec6" font-size="16">Platform listed values are estimates, separate from overall market cap.</text></g></svg>`;
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

export async function sendPhoto(snapshot, png, env = process.env, fetchImpl = fetch, history = []) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^-?\d+$/.test(env.TELEGRAM_CHAT_ID || '') || !/^\d+$/.test(env.TELEGRAM_THREAD_ID || '')) throw new Error('Telegram token, group and Notes topic are required');
  const body = new FormData();
  body.set('chat_id', env.TELEGRAM_CHAT_ID); body.set('message_thread_id', env.TELEGRAM_THREAD_ID);
  body.set('caption', caption(snapshot, history)); body.set('photo', new Blob([png], { type: 'image/png' }), 'cs2-market.png');
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body, signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error('rejected');
    return data.result.message_id;
  } catch { throw new Error('Telegram photo delivery could not be confirmed; no retry was attempted to avoid duplicates'); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--send', '--json', '--image', '--record'].includes(a))) throw new Error('Usage: node src/marketcap.js [--send] [--json] [--image] [--record]');
  const snapshot = await fetchOverview();
  let history = [];
  try { history = JSON.parse(await readFile('data/market-history.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Saved market history is unreadable'); }
  history = recordSnapshot(history, snapshot);
  if (args.includes('--record')) { await mkdir('data', { recursive: true }); await writeFile('data/market-history.json', JSON.stringify(history, null, 2) + '\n'); }
  const png = args.includes('--image') || args.includes('--send') ? chart(snapshot, history) : null;
  if (args.includes('--image')) await writeFile('marketcap-preview.png', png);
  if (args.includes('--send')) console.log(JSON.stringify({ status: 'sent', messageId: await sendPhoto(snapshot, png, process.env, fetch, history) }));
  else console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : caption(snapshot, history));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
