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

test('configured Discord feed posts one quote only to Discord without requiring Telegram credentials', async () => {
  const webhookId = '1569204810664902707';
  const channelId = '1569204810664902708';
  const discordEnv = { P2P_CRON_KEY: env.P2P_CRON_KEY,
    P2P_DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/${webhookId}/${'test_token_'.repeat(6)}` };
  let posts = 0, marketCalls = 0;
  const fetchMock = async (url, options) => {
    if (url.includes('binance.com')) {
      marketCalls++;
      const { tradeType } = JSON.parse(options.body);
      return Response.json({ code: '000000', data: [ad(tradeType === 'SELL' ? 26092 : 26100, tradeType === 'SELL' ? 'BUY' : 'SELL')] });
    }
    assert.ok(url.startsWith('https://discord.com/api/webhooks/'));
    const body = JSON.parse(options.body);
    assert.match(body.content, /MIDPOINT: 26,096 VND/);
    assert.doesNotMatch(body.content, /<b>|<i>/);
    posts++;
    return Response.json({ id: '1569204999999999999', channel_id: channelId, webhook_id: webhookId });
  };
  const request = new Request('https://example.test', { method: 'POST', headers: { 'x-p2p-cron-key': env.P2P_CRON_KEY } });
  const response = await handleRequest(request, discordEnv, fetchMock);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, platform: 'discord', message_id: '1569204999999999999', channel_id: channelId });
  assert.equal(posts, 1);
  assert.equal(marketCalls, 2);
});

test('malformed Discord configuration fails closed without falling back to Telegram', async () => {
  let calls = 0;
  const response = await handleRequest(new Request('https://example.test', { method: 'POST', headers: { 'x-p2p-cron-key': env.P2P_CRON_KEY } }),
    { ...env, P2P_DISCORD_WEBHOOK_URL: 'https://example.test/token' }, async () => { calls++; });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});

