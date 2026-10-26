import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

export const SOURCE = 'https://cs2cap.com/cs2-market-cap';
const PLATFORMS = ['BUFF163', 'Youpin898', 'CSFloat'];
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function flightOverview(flight) {
  for (const marker of flight.matchAll(/"overview"\s*:\s*\{/g)) {
    const start = marker.index + marker[0].length - 1;
    let quoted = false, escaped = false, depth = 0;
    for (let i = start; i < flight.length; i++) {
      const c = flight[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const value = JSON.parse(flight.slice(start, i + 1)); if (value.meta && value.summary) return value; } catch { /* Ignore incomplete records. */ }
        break;
      }
    }
  }
  return null;
}
const sourcePct = value => typeof value === 'number' && Number.isFinite(value) && value >= -100 && value <= 100000 ? value : null;

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
  const snapshot = { source: SOURCE, generatedAt: new Date(timestamp).toISOString(), globalCapUsd: number(globalRows[0]), platforms };
  const overview = flightOverview(flight);
  // Published rolling changes are separate from our calendar-day snapshot comparisons.
  // Use them only when the embedded summary matches this CSV and timestamp.
  if (Date.parse(overview?.meta?.generated_at) === timestamp && Number(overview?.summary?.total_marketcap_usd) === snapshot.globalCapUsd) {
    snapshot.reportedChange24hPct = sourcePct(overview.summary.change_24h_pct);
    snapshot.reportedChange7dPct = sourcePct(overview.summary.change_7d_pct);
  }
  return snapshot;
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
export function daysAgo(history, snapshot, days) {
  const date = new Date(`${dayKey(snapshot.generatedAt)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  const key = date.toISOString().slice(0, 10);
  return history.find(s => dayKey(s.generatedAt) === key);
}
export const yesterday = (history, snapshot) => daysAgo(history, snapshot, 1);
export const changePct = (value, previous) => previous > 0 ? (value / previous - 1) * 100 : null;
const delta = value => value == null ? 'recording history' : `${value > 0 ? '+' : ''}${value.toFixed(2)}% vs yesterday`;
export function caption(snapshot, history = []) {
  const prev = yesterday(history, snapshot);
  return ['CS2 daily market update (USD)', `Overall tracked market cap: ${usd(snapshot.globalCapUsd)} (${delta(changePct(snapshot.globalCapUsd, prev?.globalCapUsd))})`, '',
    ...(snapshot.reportedChange7dPct != null ? [`Source market trend: ${trendText(snapshot.reportedChange24hPct)} 24h · ${trendText(snapshot.reportedChange7dPct)} 7d`, ''] : []),
    'Marketplace listed value (estimate):', ...snapshot.platforms.map(p => `${p.name}: ${usd(p.valueUsd)} (${delta(changePct(p.valueUsd, prev?.platforms.find(v => v.name === p.name)?.valueUsd))})`), '',
    `Source snapshot: ${time(snapshot.generatedAt)} Sydney`, 'Platform totals are listed inventory value, not separate global market caps.', snapshot.source].join('\n');
}

const trendColor = change => change == null ? '#6598ff' : change > 0 ? '#44d49b' : change < 0 ? '#ff6576' : '#9aa6b8';
const trendText = change => change == null ? '—' : `${change > 0 ? '↑ +' : change < 0 ? '↓ ' : ''}${change.toFixed(2)}%`;
const compactUsd = n => `$${(n / (n >= 1e9 ? 1e9 : 1e6)).toFixed(2)}${n >= 1e9 ? 'B' : 'M'}`;
const calendarDay = date => Date.parse(`${dayKey(date)}T00:00:00Z`);
const axisDate = date => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(date));

export function chartSvg(snapshot, history = []) {
  const saved = recordSnapshot(history, snapshot);
  const end = calendarDay(snapshot.generatedAt), start = end - 6 * 86400000;
  const points = saved.filter(s => calendarDay(s.generatedAt) >= start && calendarDay(s.generatedAt) <= end);
  const prev = yesterday(saved, snapshot), week = daysAgo(saved, snapshot, 7);
  const series = [{ name: 'Overall tracked market cap', value: snapshot.globalCapUsd, previous: prev?.globalCapUsd, week: week?.globalCapUsd, values: points.map(s => s.globalCapUsd) },
    ...snapshot.platforms.map(p => ({ name: p.name, value: p.valueUsd, previous: prev?.platforms.find(v => v.name === p.name)?.valueUsd, week: week?.platforms.find(v => v.name === p.name)?.valueUsd, values: points.map(s => s.platforms.find(v => v.name === p.name)?.valueUsd) }))];
  const panels = series.map((s, i) => {
    const large = i === 0, y = large ? 144 : 650 + (i - 1) * 308, height = large ? 480 : 288;
    const change = large && snapshot.reportedChange24hPct != null ? snapshot.reportedChange24hPct : changePct(s.value, s.previous);
    const weekly = large && snapshot.reportedChange7dPct != null ? snapshot.reportedChange7dPct : changePct(s.value, s.week);
    const color = trendColor(change);
    const plot = { x: 158, y: y + (large ? 204 : 130), width: 826, height: large ? 216 : 105 };
    const values = s.values.filter(Number.isFinite), min = Math.min(...values), max = Math.max(...values);
    const padding = Math.max((max - min) * 0.16, max * 0.0025), lo = min - padding, hi = max + padding;
    const coordinates = s.values.map((v, n) => ({ x: plot.x + (calendarDay(points[n].generatedAt) - start) / (end - start) * plot.width, y: plot.y + plot.height - (v - lo) / (hi - lo) * plot.height }));
    const path = coordinates.map((p, n) => `${n ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const last = coordinates.at(-1);
    const grid = [0, 0.5, 1].map(f => `<path d="M${plot.x},${plot.y + f * plot.height}H${plot.x + plot.width}" stroke="#2c3340" stroke-dasharray="4 7"/><text x="${plot.x - 18}" y="${plot.y + f * plot.height + 7}" text-anchor="end" fill="#8490a3" font-size="20">${compactUsd(hi - f * (hi - lo))}</text>`).join('');
    const dates = [0, 0.5, 1].map(f => `<text x="${plot.x + f * plot.width}" y="${plot.y + plot.height + 32}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" fill="#8490a3" font-size="20">${axisDate(start + f * (end - start))}</text>`).join('');
    const line = coordinates.length > 1 ? `<path d="${path} L${last.x},${plot.y + plot.height} L${coordinates[0].x},${plot.y + plot.height}Z" fill="url(#area${i})"/><path d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>` : `<text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height / 2 + 7}" text-anchor="middle" fill="#97a5ba" font-size="22">First daily snapshot · trend builds each day</text>`;
    const metrics = large ? `<text x="68" y="${y + 144}" fill="#8490a3" font-size="21">${snapshot.reportedChange24hPct != null ? '24h · source trend' : 'vs yesterday'}</text><text x="68" y="${y + 177}" fill="${color}" font-size="29" font-weight="bold">${trendText(change)}</text><text x="365" y="${y + 144}" fill="#8490a3" font-size="21">${snapshot.reportedChange7dPct != null ? '7d · source trend' : 'vs last week'}</text><text x="365" y="${y + 177}" fill="${trendColor(weekly)}" font-size="29" font-weight="bold">${trendText(weekly)}</text>` : `<text x="1000" y="${y + 46}" text-anchor="end" fill="${color}" font-size="24" font-weight="bold">${trendText(change)}  1D</text><text x="1000" y="${y + 82}" text-anchor="end" fill="${trendColor(weekly)}" font-size="22">${trendText(weekly)}  1W</text>`;
    return `<defs><linearGradient id="area${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.18"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><rect x="36" y="${y}" width="1008" height="${height}" rx="18" fill="#1c2029"/><text x="68" y="${y + 44}" fill="#cbd4e4" font-size="${large ? 26 : 27}" font-weight="bold">${s.name}</text><text x="68" y="${y + (large ? 100 : 88)}" fill="#fff" font-size="${large ? 47 : 34}" font-weight="bold">${usd(s.value)}</text>${large ? `<rect x="879" y="${y + 23}" width="127" height="39" rx="8" fill="#2e4f84"/><text x="942" y="${y + 50}" text-anchor="middle" fill="#d9e8ff" font-size="21">7 DAYS</text>` : ''}${metrics}${grid}${line}<circle cx="${last.x}" cy="${last.y}" r="7" fill="${color}" stroke="#1c2029" stroke-width="3"/>${dates}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1690"><rect width="1080" height="1690" rx="24" fill="#13161d"/><g font-family="DejaVu Sans, Arial, sans-serif"><rect x="36" y="30" width="8" height="66" rx="4" fill="#6598ff"/><text x="65" y="62" fill="#fff" font-size="33" font-weight="bold">CS2 MARKET TRENDS</text><text x="65" y="98" fill="#97a5ba" font-size="22">${time(snapshot.generatedAt)} Sydney · USD</text>${panels}<text x="68" y="635" fill="#8490a3" font-size="18">MARKETPLACE LISTED INVENTORY VALUE · ESTIMATES</text><text x="48" y="1608" fill="#97a5ba" font-size="19">Daily snapshots · Green up / red down · — = no comparison yet</text><text x="48" y="1640" fill="#8490a3" font-size="18">CS2Cap · Each graph has its own scale · History since ${axisDate(calendarDay(saved[0].generatedAt))}</text><text x="48" y="1668" fill="#8490a3" font-size="18">Platform listed values are separate from overall market cap.</text></g></svg>`;
}

export function chart(snapshot, history = []) {
  return new Resvg(chartSvg(snapshot, history), { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
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
