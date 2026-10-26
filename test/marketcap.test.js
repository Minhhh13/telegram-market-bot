import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseOverview, caption, chart, chartSvg, sendPhoto, recordSnapshot, yesterday, daysAgo, changePct } from '../src/marketcap.js';

const now = new Date('2026-10-26T12:00:00Z');
const csv = 'section,name,value,items\nsummary,total_marketcap_usd,4723301452.04,46139\nmarketplace_listed_value,BUFF163,96453369.36,3566735\nmarketplace_listed_value,Youpin898,114426488.50,6138688\nmarketplace_listed_value,CSFloat,61543105.87,2372616\nmarketplace_listed_value,BUFF Market,999,1';
const html = (data = csv, date = now.toISOString()) => `<a href="data:text/csv;charset=utf-8,${encodeURIComponent(data)}" download="cs2cap-market-overview.csv">Export CSV</a><script>self.__next_f.push(${JSON.stringify([1, `f:{"overview":{"meta":{"generated_at":"${date}"}}}\n`])})</script>`;

test('parses publisher CSV exactly and selects BUFF163 separately from BUFF Market', () => {
  const snapshot = parseOverview(html(), now);
  assert.equal(snapshot.globalCapUsd, 4723301452.04);
  assert.equal(snapshot.platforms[0].valueUsd, 96453369.36);
  assert.equal(snapshot.platforms[1].name, 'YouPin898');
  assert.equal(snapshot.platforms.length, 3);
  assert.match(caption(snapshot), /listed value \(estimate\)/);
});
test('fails on stale, future, absent or duplicate source values', () => {
  assert.throws(() => parseOverview(html(csv, '2026-10-25T00:00:00Z'), now), /stale/);
  assert.throws(() => parseOverview(html(csv, '2026-10-27T00:00:00Z'), now), /stale/);
  assert.throws(() => parseOverview(html(csv.replace('CSFloat', 'Other')), now), /CSFloat/);
  assert.throws(() => parseOverview(html(csv + '\nmarketplace_listed_value,BUFF163,2,1'), now), /duplicated/);
});
test('CSV handles quoted delimiters and rejects unterminated fields', () => {
  assert.equal(parseCsv('section,name,value\nx,"a,b",3')[0].name, 'a,b');
  assert.throws(() => parseCsv('section,name,value\nx,"broken,3'), /Invalid/);
});
test('chart renders an actual PNG and caption stays under Telegram photo limit', () => {
  const snapshot = parseOverview(html(), now);
  assert.equal(chart(snapshot).subarray(1, 4).toString(), 'PNG');
  assert.ok(caption(snapshot).length < 1024);
});
test('photo sends once and does not expose credential on ambiguous failure', async () => {
  let calls = 0;
  await assert.rejects(sendPhoto(parseOverview(html(), now), Buffer.from('png'), { TELEGRAM_BOT_TOKEN: 'secret', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_THREAD_ID: '4' }, async () => { calls++; throw new Error('secret'); }), /no retry/);
  assert.equal(calls, 1);
});
test('daily history replaces same-day snapshots and compares only actual yesterday', () => {
  const current = parseOverview(html(), now);
  const prior = { ...current, generatedAt: '2026-10-25T12:00:00.000Z', globalCapUsd: current.globalCapUsd / 1.1 };
  const history = recordSnapshot([prior], current);
  assert.equal(yesterday(history, current), prior);
  assert.ok(Math.abs(changePct(current.globalCapUsd, prior.globalCapUsd) - 10) < 1e-10);
  assert.equal(recordSnapshot(history, current).length, 2);
  assert.equal(yesterday([], current), undefined);
  assert.equal(changePct(1, undefined), null);
  assert.match(caption(current, history), /\+10.00% vs yesterday/);
  assert.ok(caption(current, history).length < 1024);
});

test('weekly comparison uses seven calendar days ago, even across Sydney daylight saving', () => {
  const base = parseOverview(html(), now);
  const current = { ...base, generatedAt: '2026-10-04T13:15:00.000Z' }; // 5 Oct Sydney, after DST starts.
  const week = { ...base, generatedAt: '2026-09-27T14:15:00.000Z', globalCapUsd: current.globalCapUsd / 1.1 }; // 28 Sep Sydney.
  const wrongDay = { ...base, generatedAt: '2026-09-28T14:15:00.000Z' };
  assert.equal(daysAgo([wrongDay, week], current, 7), week);
  assert.equal(daysAgo([wrongDay], current, 7), undefined);
  assert.match(chartSvg(current, [week]), /↑ \+10.00%/);
});

test('seven-day chart shows real points, missing comparisons and both trend directions', () => {
  const current = parseOverview(html(), now);
  const firstDay = chartSvg(current);
  assert.match(firstDay, /First daily snapshot/);
  assert.doesNotMatch(firstDay, /NaN|Infinity|undefined/);
  const previous = { ...current, generatedAt: '2026-10-25T12:00:00.000Z', globalCapUsd: current.globalCapUsd / 1.1,
    platforms: current.platforms.map(p => ({ ...p, valueUsd: p.valueUsd / 0.9 })) };
  const svg = chartSvg(current, [previous]);
  assert.match(svg, /↑ \+10.00%/);
  assert.match(svg, /↓ -10.00%/);
  assert.match(svg, /#44d49b/);
  assert.match(svg, /#ff6576/);
  assert.doesNotMatch(svg, /NaN|Infinity|undefined|First daily snapshot/);
  assert.equal(chart(current, [previous]).readUInt32BE(16), 1080);
});
