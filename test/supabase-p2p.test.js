import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../supabase/telegram-p2p-rate/index.ts';

const env = {
  P2P_CRON_KEY: 'a-long-test-key-with-more-than-32-characters',
  P2P_TELEGRAM_TOKEN: 'dummy-bot-token',
  P2P_CHAT_ID: '-100123',
  P2P_THREAD_ID: '20',
};

function ad(price, tradeType, changes = {}) {
  return { adv: {
    advNo: `${price}-${tradeType}`, asset: 'USDT', fiatUnit: 'VND', isTradable: true,
    tradeType, price: String(price), minSingleTransAmount: '1000000',
    maxSingleTransAmount: '100000000', dynamicMaxSingleTransAmount: '100000000',
    tradableQuantity: '10000', ...changes,
  } };
}

test('scheduled endpoint requires its own secret before fetching market data', async () => {
  let calls = 0;
  const response = await handleRequest(new Request('https://example.test', { method: 'POST' }), env, async () => { calls++; });
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test('scheduled endpoint posts one fresh executable quote to the configured topic', async () => {
  let telegramPosts = 0;
  const fetchMock = async (url, options) => {
    if (url.includes('binance.com')) {
      const { tradeType } = JSON.parse(options.body);
      const rows = tradeType === 'SELL'
        ? [ad(30000, 'BUY', { maxSingleTransAmount: '150000' }), ad(26092, 'BUY')]
        : [ad(26100, 'SELL'), ad(26110, 'SELL')];
      return Response.json({ code: '000000', success: true, data: rows });
    }
    telegramPosts++;
    assert.equal(url, 'https://api.telegram.org/botdummy-bot-token/sendMessage');
    const sent = JSON.parse(options.body);
    assert.equal(sent.chat_id, '-100123');
    assert.equal(sent.message_thread_id, 20);
    assert.match(sent.text, /RED: 26,092 VND/);
    assert.match(sent.text, /GREEN: 26,100 VND/);
    assert.match(sent.text, /MIDPOINT: 26,096 VND/);
    return Response.json({ ok: true, result: { message_id: 72 } });
  };
  const request = new Request('https://example.test', { method: 'POST', headers: { 'x-p2p-cron-key': env.P2P_CRON_KEY } });
  const response = await handleRequest(request, env, fetchMock);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, message_id: 72 });
  assert.equal(telegramPosts, 1);
});

