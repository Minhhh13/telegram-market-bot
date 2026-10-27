import { Resvg, initWasm } from 'npm:@resvg/resvg-wasm@2.6.2';

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
    const change = matches[0].change_24h_pct?.trim();
    const reportedChange24hPct = change ? sourcePct(Number(change)) : null;
    return { name: name === 'Youpin898' ? 'YouPin898' : name, valueUsd: number(matches[0]),
      ...(reportedChange24hPct != null ? { reportedChange24hPct } : {}) };
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

export function chartSvg(snapshot, history = [], index = 0) {
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error('Invalid chart index');
  const saved = recordSnapshot(history, snapshot);
  const end = calendarDay(snapshot.generatedAt), start = end - 6 * 86400000;
  const points = saved.filter(s => calendarDay(s.generatedAt) >= start && calendarDay(s.generatedAt) <= end);
  const prev = yesterday(saved, snapshot), week = daysAgo(saved, snapshot, 7);
  const platform = index ? snapshot.platforms[index - 1] : null;
  const s = platform ? { name: platform.name, value: platform.valueUsd, previous: prev?.platforms.find(p => p.name === platform.name)?.valueUsd,
    week: week?.platforms.find(p => p.name === platform.name)?.valueUsd, values: points.map(p => p.platforms.find(v => v.name === platform.name)?.valueUsd),
    published24h: platform.reportedChange24hPct } : { name: 'OVERALL CS2 MARKET', value: snapshot.globalCapUsd,
    previous: prev?.globalCapUsd, week: week?.globalCapUsd, values: points.map(p => p.globalCapUsd), published24h: snapshot.reportedChange24hPct };
  const daily = s.published24h ?? changePct(s.value, s.previous);
  const weekly = index === 0 && snapshot.reportedChange7dPct != null ? snapshot.reportedChange7dPct : changePct(s.value, s.week);
  const lineColor = s.values.length > 1 ? trendColor(changePct(s.value, s.values[0])) : '#6598ff';
  const plot = { x: 190, y: 625, width: 890, height: 350 };
  const values = s.values.filter(Number.isFinite), min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * 0.16, max * 0.0025), lo = min - padding, hi = max + padding;
  const coordinates = s.values.map((v, n) => ({ x: plot.x + (calendarDay(points[n].generatedAt) - start) / (end - start) * plot.width,
    y: plot.y + plot.height - (v - lo) / (hi - lo) * plot.height }));
  const path = coordinates.map((p, n) => `${n ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = coordinates.at(-1);
  const grid = [0, 0.5, 1].map(f => `<path d="M${plot.x},${plot.y + f * plot.height}H${plot.x + plot.width}" stroke="#343c4a" stroke-dasharray="4 9"/><text x="${plot.x - 22}" y="${plot.y + f * plot.height + 9}" text-anchor="end" fill="#95a3b8" font-size="24">${compactUsd(hi - f * (hi - lo))}</text>`).join('');
  const dates = [0, 0.5, 1].map(f => `<text x="${plot.x + f * plot.width}" y="1020" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" fill="#95a3b8" font-size="24">${axisDate(start + f * (end - start))}</text>`).join('');
  const line = coordinates.length > 1 ? `<path d="${path} L${last.x},${plot.y + plot.height} L${coordinates[0].x},${plot.y + plot.height}Z" fill="url(#area)"/><path d="${path}" fill="none" stroke="${lineColor}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>` : `<text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height / 2}" text-anchor="middle" fill="#b0bdd0" font-size="28">First daily reading</text><text x="${plot.x + plot.width / 2}" y="${plot.y + plot.height / 2 + 38}" text-anchor="middle" fill="#8292aa" font-size="23">The line grows with each daily update</text>`;
  const metric = (x, title, value, note) => `<rect x="${x}" y="340" width="510" height="125" rx="18" fill="#222a37"/><text x="${x + 30}" y="379" fill="#9daac0" font-size="23">${title}</text><text x="${x + 30}" y="431" fill="${value == null ? '#9daac0' : trendColor(value)}" font-size="43" font-weight="bold">${value == null ? 'Collecting' : trendText(value)}</text><text x="${x + 477}" y="431" text-anchor="end" fill="#7e90aa" font-size="20">${note}</text>`;
  const dailyNote = s.published24h != null ? 'source' : 'saved';
  const weekNote = index === 0 && snapshot.reportedChange7dPct != null ? 'source' : 'saved';
  const description = index ? 'Listed inventory value · estimate · USD' : 'Tracked market cap · USD';
  const footer = index ? 'Marketplace listed value is separate from the overall CS2 market cap.' : 'Tracked items × indexed prices across the CS2 market.';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${lineColor}" stop-opacity="0.24"/><stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/></linearGradient></defs><rect width="1200" height="1200" rx="28" fill="#11151e"/><g font-family="DejaVu Sans, Arial, sans-serif"><rect x="60" y="57" width="9" height="78" rx="4" fill="#6598ff"/><text x="87" y="90" fill="#99a9c1" font-size="24" letter-spacing="2">CS2 MARKET TRENDS</text><text x="87" y="132" fill="#fff" font-size="41" font-weight="bold">${s.name}</text><text x="62" y="208" fill="#96a7bd" font-size="25">${description}</text><text x="62" y="291" fill="#fff" font-size="69" font-weight="bold">${usd(s.value)}</text><text x="1138" y="112" text-anchor="end" fill="#9daac0" font-size="22">${time(snapshot.generatedAt)} Sydney</text>${metric(60, '24H CHANGE', daily, dailyNote)}${metric(630, '7D CHANGE', weekly, weekNote)}<rect x="60" y="505" width="1080" height="566" rx="22" fill="#1c222d"/><text x="90" y="558" fill="#d5deec" font-size="25" font-weight="bold">DAILY VALUE · LAST 7 DAYS</text><text x="1110" y="558" text-anchor="end" fill="#91a3bb" font-size="22">${points.length} ${points.length === 1 ? 'reading' : 'readings'}</text>${grid}${line}<circle cx="${last.x}" cy="${last.y}" r="10" fill="${lineColor}" stroke="#1c222d" stroke-width="4"/>${dates}<text x="62" y="1124" fill="#aab8cb" font-size="23">${footer}</text><text x="62" y="1160" fill="#788ca8" font-size="22">CS2Cap · Changes: green up / red down · Daily snapshots from ${axisDate(calendarDay(saved[0].generatedAt))}</text></g></svg>`;
}

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm';
const FONT_REGULAR_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2';
const FONT_BOLD_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-700-normal.woff2';
let rendererReady;

async function initRenderer() {
  if (!rendererReady) rendererReady = (async () => {
    const [wasm, regular, bold] = await Promise.all([fetch(WASM_URL), fetch(FONT_REGULAR_URL), fetch(FONT_BOLD_URL)]);
    if (!wasm.ok || !regular.ok || !bold.ok) throw new Error('Chart assets unavailable');
    await initWasm(wasm.arrayBuffer());
    return [new Uint8Array(await regular.arrayBuffer()), new Uint8Array(await bold.arrayBuffer())];
  })();
  return rendererReady;
}

async function renderCharts(snapshot, history) {
  const fontBuffers = await initRenderer();
  return [0, 1, 2, 3].map(index => {
    const svg = chartSvg(snapshot, history, index).replace('DejaVu Sans, Arial, sans-serif', 'Inter, Arial, sans-serif');
    const renderer = new Resvg(svg, { font: { loadSystemFonts: false, defaultFontFamily: 'Inter', fontBuffers } });
    try { return renderer.render().asPng(); } finally { renderer.free(); }
  });
}

async function fetchCurrentSnapshot() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(SOURCE, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Source HTTP error');
      return parseOverview(await response.text());
    } catch {
      if (attempt === 2) throw new Error('Market-cap source unavailable');
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  }
}

function config() {
  const value = name => Deno.env.get(name) || '';
  const token = value('P2P_TELEGRAM_TOKEN');
  const chatId = value('P2P_CHAT_ID');
  const threadId = value('MARKETCAP_THREAD_ID');
  const url = value('SUPABASE_URL');
  const serviceKey = value('SUPABASE_SERVICE_ROLE_KEY');
  const cronKey = value('MARKETCAP_CRON_KEY');
  if (!token || !/^-?\d+$/.test(chatId) || !/^\d+$/.test(threadId) || !url || !serviceKey || cronKey.length < 32) throw new Error('Market bot configuration incomplete');
  return { token, chatId, threadId, url, serviceKey, cronKey };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sameSecret = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

async function readHistory(cfg) {
  const response = await fetch(`${cfg.url}/rest/v1/telegram_market_snapshots?select=payload,sent_at&order=snapshot_date.asc&limit=90`, {
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Market history unavailable');
  const rows = await response.json();
  return rows.map(row => ({ ...row.payload, sentAt: row.sent_at }));
}

async function saveSnapshot(cfg, snapshot, messageIds) {
  const response = await fetch(`${cfg.url}/rest/v1/telegram_market_snapshots?on_conflict=snapshot_date`, {
    method: 'POST',
    headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ snapshot_date: dayKey(snapshot.generatedAt), payload: snapshot, sent_at: new Date().toISOString(), message_ids: messageIds }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Market history could not be saved');
}

async function sendAlbum(cfg, snapshot, images, history) {
  const body = new FormData();
  body.set('chat_id', cfg.chatId);
  body.set('message_thread_id', cfg.threadId);
  const media = images.map((png, index) => {
    const name = `chart${index}`;
    body.set(name, new Blob([png], { type: 'image/png' }), `${index ? snapshot.platforms[index - 1].name : 'overall'}-market.png`);
    return { type: 'photo', media: `attach://${name}`, ...(index === 0 ? { caption: caption(snapshot, history) } : {}) };
  });
  body.set('media', JSON.stringify(media));
  const response = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMediaGroup`, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || result.ok !== true || !Array.isArray(result.result) || result.result.length !== 4) throw new Error('Telegram album delivery failed');
  return result.result.map(item => item.message_id);
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const cfg = config();
    if (!sameSecret(request.headers.get('x-marketcap-cron-key') || '', cfg.cronKey)) return json({ error: 'Unauthorized' }, 401);
    const input = await request.json().catch(() => ({}));
    const snapshot = await fetchCurrentSnapshot();
    const history = await readHistory(cfg);
    const today = history.find(item => dayKey(item.generatedAt) === dayKey(snapshot.generatedAt));
    if (today?.sentAt && !input.preview) return json({ ok: true, skipped: 'already sent today' });
    const images = await renderCharts(snapshot, history);
    if (input.preview) return json({ ok: true, snapshot, pngBytes: images.map(image => image.length) });
    const messageIds = await sendAlbum(cfg, snapshot, images, history);
    await saveSnapshot(cfg, snapshot, messageIds);
    return json({ ok: true, message_ids: messageIds });
  } catch (error) {
    console.error('Daily market update failed');
    return json({ error: 'Daily market update failed' }, 502);
  }
});


