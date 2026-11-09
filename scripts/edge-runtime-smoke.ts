// Deno-only smoke check of the actual daily Edge handler and WASM renderer. Source data, history
// and outgoing destinations are mocked; only the pinned chart CDN is contacted.
import assert from 'node:assert/strict';

const env = { MARKETCAP_CRON_KEY: 'runtime-test-key-with-more-than-32-characters',
  SUPABASE_URL: 'https://project.example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  MARKETCAP_DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/1569204874803937381/${'test_token_'.repeat(6)}`,
  P2P_TELEGRAM_TOKEN: 'test-telegram', P2P_CHAT_ID: '-1001', MARKETCAP_THREAD_ID: '4' };
const date = new Date(Date.now() - 60_000).toISOString();
const snapshot = { source: 'https://cs2cap.com/cs2-market-cap', generatedAt: date, globalCapUsd: 4_723_301_452,
  platforms: [{ name: 'BUFF163', valueUsd: 96_453_369 }, { name: 'YouPin898', valueUsd: 114_426_488 }, { name: 'CSFloat', valueUsd: 61_543_105 }] };
const csv = ['section,name,value', 'summary,total_marketcap_usd,4723301452', 'marketplace_listed_value,BUFF163,96453369',
  'marketplace_listed_value,Youpin898,114426488', 'marketplace_listed_value,CSFloat,61543105'].join('\n');
const html = `<a download="cs2cap-market-overview.csv" href="data:text/csv;charset=utf-8,${encodeURIComponent(csv)}">CSV</a><script>self.__next_f.push(${JSON.stringify([1, JSON.stringify({ overview: { meta: { generated_at: date } } })])})</script>`;
let rows = [{ payload: snapshot, sent_at: date, message_ids: [10, 11, 12, 13] }];
let handler, delivered = 0, saved = 0;
const original = { fetch: globalThis.fetch, serve: Deno.serve, getEnv: Deno.env.get };
try {
  Deno.env.get = name => env[name];
  Deno.serve = value => { handler = value; return {}; };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://cdn.jsdelivr.net/')) return original.fetch(url, options);
    if (target === snapshot.source) return new Response(html);
    if (target.startsWith(env.SUPABASE_URL + '/rest/v1/telegram_market_snapshots')) {
      if (options.method === 'POST') { saved++; const row = JSON.parse(options.body); rows = [row]; return new Response(null, { status: 204 }); }
      return Response.json(rows);
    }
    assert.ok(target.startsWith(env.MARKETCAP_DISCORD_WEBHOOK_URL + '?wait=true'), 'Only Discord may receive this report');
    delivered++;
    const payload = JSON.parse(options.body.get('payload_json'));
    assert.equal(payload.attachments.length, 4);
    assert.match(payload.content, /Overall tracked market cap/);
    for (let i = 0; i < 4; i++) {
      const png = new Uint8Array(await options.body.get(`files[${i}]`).arrayBuffer());
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.length > 10_000);
    }
    return Response.json({ id: '1569204999999999999', channel_id: '1569204874803937381',
      webhook_id: '1569204874803937381', attachments: payload.attachments });
  };
  await import(Deno.args.includes('--bundle') ? '../.deploy/telegram-marketcap.ts' : '../supabase/telegram-marketcap/index.ts');
  const request = (input = {}, authenticated = true) => new Request('https://project.example.test/functions/v1/telegram-marketcap', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'x-marketcap-cron-key': env.MARKETCAP_CRON_KEY } : {}) }, body: JSON.stringify(input) });
  assert.equal((await handler(request({}, false))).status, 401);
  assert.equal(delivered, 0);
  const first = await handler(request());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, message_ids: ['1569204999999999999'] });
  assert.equal(delivered, 1);
  assert.equal(saved, 1);
  assert.deepEqual(rows[0].message_ids.deliveries.telegram.ids, [10, 11, 12, 13]);
  assert.deepEqual(rows[0].message_ids.deliveries['discord:1569204874803937381'].ids, ['1569204999999999999']);
  assert.equal((await (await handler(request())).json()).skipped, 'already sent today');
  assert.equal(delivered, 1);
  const preview = await (await handler(request({ preview: true }))).json();
  assert.equal(preview.pngBytes.length, 4);
  assert.ok(preview.pngBytes.every(size => size > 10_000));
  assert.equal(delivered, 1);
  assert.equal(saved, 1);
  delete env.MARKETCAP_DISCORD_WEBHOOK_URL;
  assert.equal((await (await handler(request())).json()).skipped, 'already sent today');
  assert.equal(delivered, 1);
  console.log('Daily Edge runtime passed: auth, real WASM charts, one Discord report, preserved Telegram history, daily deduplication and preview without sends.');
} finally {
  globalThis.fetch = original.fetch; Deno.serve = original.serve; Deno.env.get = original.getEnv;
}
