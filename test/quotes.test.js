import test from 'node:test';
import assert from 'node:assert/strict';
import { midpoint, selectQuote, formatMessage } from '../src/quotes.js';
import { readConfig, sendTelegram } from '../src/index.js';

function ad(price, fields = {}, extra = {}) {
  return { adv: {
    advNo: String(price), asset: 'USDT', fiatUnit: 'VND', isTradable: true, tradeType: 'BUY',
    price: String(price), minSingleTransAmount: '1000000', maxSingleTransAmount: '100000000',
    dynamicMaxSingleTransAmount: '100000000', tradableQuantity: '10000', ...fields,
  }, advertiser: { nickName: 'Merchant' }, ...extra };
}

test('red selects highest executable price, not a pinned promoted offer', () => {
  const rows = [ad('25189', {}, { privilegeType: 1 }), ad('26090'), ad('26092')];
  assert.equal(selectQuote(rows, 'SELL').price, '26092');
});

test('green selects lowest executable price and checks opposite ad direction', () => {
  const rows = [ad('25900'), ad('26110', { tradeType: 'SELL' }), ad('26100', { tradeType: 'SELL' })];
  assert.equal(selectQuote(rows, 'BUY').price, '26100');
});

test('tiny upper limits cannot inflate red quote', () => {
  const rows = [ad('30000', { maxSingleTransAmount: '150000' }), ad('26092')];
  assert.equal(selectQuote(rows, 'SELL').price, '26092');
});

test('a small minimum is allowed when the same ad can actually fill 20 million VND', () => {
  const rows = [ad('26100', { tradeType: 'SELL', minSingleTransAmount: '150000', maxSingleTransAmount: '50000000' })];
  assert.equal(selectQuote(rows, 'BUY').price, '26100');
});

test('enforces minimum, dynamic maximum, quantity and tradability', () => {
  const rows = [
    ad('30004', { minSingleTransAmount: '80000000' }),
    ad('30003', { dynamicMaxSingleTransAmount: '19999999.99' }),
    ad('30002', { tradableQuantity: '1' }),
    ad('30001', { isTradable: false }),
    ad('26092', { minSingleTransAmount: '20000000', dynamicMaxSingleTransAmount: '20000000' }),
  ];
  assert.equal(selectQuote(rows, 'SELL').price, '26092');
});

test('fractional capacity just below target fails without floating-point rounding', () => {
  assert.throws(() => selectQuote([ad('20000', { tradableQuantity: '999.999999999999999999' })], 'SELL'), /No SELL/);
});

test('malformed or absent availability fails closed and stale prices are never substituted', () => {
  assert.throws(() => selectQuote([ad('NaN'), ad('0'), ad('26092', { dynamicMaxSingleTransAmount: undefined })], 'SELL'), /No SELL/);
});

test('midpoint averages both prices and rounds half up exactly', () => {
  assert.equal(midpoint('26010', '26100'), 26055n);
  assert.equal(midpoint('26010', '26101'), 26056n);
  assert.equal(midpoint('26010.49', '26010.50'), 26010n);
  assert.equal(midpoint('26010.50', '26010.50'), 26011n);
});

test('message includes per-unit prices, midpoint, amount filter and Vietnam timestamp', () => {
  const text = formatMessage({ red: { price: '26010' }, green: { price: '26100' }, amountVnd: '20000000', timestamp: new Date('2026-10-26T00:00:00Z') });
  assert.match(text, /RED: 26,010\nGREEN: 26,100\nMIDPOINT \(RED \+ GREEN\) \/ 2: 26,055/);
  assert.match(text, /20,000,000 VND/);
  assert.match(text, /07:00 ICT/);
});

test('invalid amounts fail before any market request', () => {
  for (const amount of ['0', '-10', 'NaN', '2e7', '20.5']) assert.throws(() => readConfig({ QUOTE_AMOUNT_VND: amount }));
});

test('Telegram timeout is not retried and does not expose secret', async () => {
  let calls = 0;
  await assert.rejects(sendTelegram({ token: 'secret-test-token', chatId: '-100123' }, 'Example', async () => {
    calls++;
    throw new Error('URL included secret-test-token');
  }), (error) => /will not retry/.test(error.message) && !error.message.includes('secret-test-token'));
  assert.equal(calls, 1);
});

test('Telegram posts to configured numeric group and topic', async () => {
  let sent;
  await sendTelegram({ token: 'test-token', chatId: '-100123', threadId: '42' }, 'Example', async (url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 50, chat: { id: -100123 } } }) };
  });
  assert.deepEqual(sent, { chat_id: '-100123', message_thread_id: 42, text: 'Example' });
});
