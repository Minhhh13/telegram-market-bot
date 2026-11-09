import test from 'node:test';
import assert from 'node:assert/strict';
import { discordWebhook, discordText, sendDiscordWebhook } from '../supabase/_shared/discord-delivery.ts';
import { deliveryReceipts, addDeliveryReceipt } from '../supabase/_shared/delivery-history.ts';

const webhookId = '1569204810664902707';
const channelId = '1569204874803937381';
const messageId = '1569204999999999999';
const webhook = `https://discord.com/api/webhooks/${webhookId}/${'test_token_'.repeat(6)}`;
const receipt = { id: messageId, channel_id: channelId, webhook_id: webhookId };

test('webhook validation permits only channel-scoped Discord endpoints with confirmed delivery', () => {
  assert.equal(discordWebhook(webhook).url.search, '?wait=true');
  for (const invalid of [webhook.replace('discord.com', 'example.test'), webhook.replace('https:', 'http:'),
    webhook.replace('discord.com', 'discord.com.example.test'), webhook + '?wait=false', webhook + '#token',
    webhook.replace('discord.com', 'user:password@discord.com')]) {
    assert.throws(() => discordWebhook(invalid), /^Error: Discord webhook is not configured correctly$/);
  }
});

test('P2P formatting preserves every line and disables pings and link previews', async () => {
  const raw = '<b>Binance P2P</b>\n🟥 RED: 26,092 VND\n🟩 GREEN: 26,100 VND\n<b>MIDPOINT: 26,096 VND</b>\n<i>20,000,000 VND</i>';
  let calls = 0;
  const result = await sendDiscordWebhook(webhook, discordText(raw), { username: 'Binance P2P Rates' }, async (url, options) => {
    calls++;
    assert.equal(url, webhook + '?wait=true');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.content, '**Binance P2P**\n🟥 RED: 26,092 VND\n🟩 GREEN: 26,100 VND\n**MIDPOINT: 26,096 VND**\n*20,000,000 VND*');
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.flags, 4);
    return Response.json(receipt);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { platform: 'discord', messageId, channelId, webhookId });
});

test('uncertain, rejected, wrong-webhook and incomplete deliveries never retry or expose credentials', async () => {
  for (const response of [null, Response.json({ ...receipt, webhook_id: '1569204810664902708' }),
    Response.json({ message: webhook }, { status: 429 }), new Response(null, { status: 204 })]) {
    let calls = 0;
    await assert.rejects(sendDiscordWebhook(webhook, 'Test', {}, async () => {
      calls++;
      if (!response) throw new Error(webhook);
      return response;
    }), /^Error: Discord delivery could not be confirmed; no retry was attempted$/);
    assert.equal(calls, 1);
  }
});

test('invalid content and oversized charts are rejected before any outgoing request', async () => {
  let calls = 0;
  const fetchMock = async () => { calls++; };
  await assert.rejects(sendDiscordWebhook(webhook, 'x'.repeat(2001), {}, fetchMock), /2000/);
  await assert.rejects(sendDiscordWebhook(webhook, 'Report', { images: Array(5).fill(new Uint8Array([1])) }, fetchMock), /attachments/);
  await assert.rejects(sendDiscordWebhook(webhook, 'Report', { images: [new Uint8Array(8_000_001)] }, fetchMock), /attachments/);
  assert.equal(calls, 0);
});

test('a missing chart receipt fails without retrying or claiming a complete report', async () => {
  let calls = 0;
  await assert.rejects(sendDiscordWebhook(webhook, 'Four charts', { images: Array(4).fill(new Uint8Array([1])) }, async () => {
    calls++;
    return Response.json({ ...receipt, attachments: [{ id: '0' }] });
  }), /could not be confirmed; no retry/);
  assert.equal(calls, 1);
});

test('daily migration preserves Telegram history and independently tracks each Discord destination', () => {
  const telegram = deliveryReceipts({ sent_at: '2026-11-09T22:37:00Z', message_ids: [1, 2, 3, 4] });
  assert.equal(telegram.telegram.sentAt, '2026-11-09T22:37:00Z');
  assert.equal(telegram[`discord:${webhookId}`], undefined);
  const migrated = addDeliveryReceipt(telegram, `discord:${webhookId}`, [messageId], '2026-11-09T23:00:00Z');
  const saved = deliveryReceipts({ message_ids: { deliveries: migrated } });
  assert.equal(saved[`discord:${webhookId}`].sentAt, '2026-11-09T23:00:00Z');
  assert.deepEqual(saved.telegram.ids, [1, 2, 3, 4]);
  assert.equal(saved['discord:another-channel'], undefined);
  assert.deepEqual(telegram.telegram.ids, [1, 2, 3, 4]);
  assert.equal(Object.keys(telegram).length, 1);
});
