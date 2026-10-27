import test from 'node:test';
import assert from 'node:assert/strict';
import { recentScheduledRuns, shouldSend } from '../src/schedule-guard.js';

const now = new Date('2026-10-27T02:20:00Z');
const context = { GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '20', GH_TOKEN: 'private-token' };
const run = (id, time, conclusion = 'success') => ({ id, event: 'schedule', status: 'completed', conclusion, run_started_at: time });

test('checks completed scheduled runs within 50 minutes', () => {
  assert.deepEqual(recentScheduledRuns([run(19, '2026-10-27T01:31:00Z')], now, '20').map(x => x.id), [19]);
  assert.deepEqual(recentScheduledRuns([run(19, '2026-10-27T01:30:00Z')], now, '20'), []);
});

test('manual, current and future runs do not suppress a quote', () => {
  assert.deepEqual(recentScheduledRuns([{ ...run(19, '2026-10-27T02:00:00Z'), event: 'workflow_dispatch' }], now, '20'), []);
  assert.deepEqual(recentScheduledRuns([run(20, '2026-10-27T02:00:00Z')], now, '20'), []);
  assert.deepEqual(recentScheduledRuns([run(21, '2026-10-27T02:30:00Z')], now, '20'), []);
});

test('manual run bypasses schedule check and API errors fail closed', async () => {
  assert.equal(await shouldSend({ GITHUB_EVENT_NAME: 'workflow_dispatch' }, () => { throw new Error('unreachable'); }, now), true);
  await assert.rejects(shouldSend(context, async () => ({ ok: false }), now), /Could not check/);
});

test('a prior send attempt suppresses another quote without leaking the token', async () => {
  const requested = [];
  const send = await shouldSend(context, async (url, options) => {
    requested.push({ url, options });
    return { ok: true, json: async () => url.includes('/jobs?')
      ? { jobs: [{ steps: [{ name: 'Send fresh quote to Telegram', status: 'completed', conclusion: 'failure' }] }] }
      : { workflow_runs: [run(19, '2026-10-27T02:00:00Z', 'failure')] } };
  }, now);
  assert.equal(send, false);
  assert.match(requested[0].url, /event=schedule&status=completed/);
  assert.match(requested[1].url, /\/runs\/19\/jobs/);
  assert.ok(requested.every(r => r.options.headers.Authorization === 'Bearer private-token' && !r.url.includes('private-token')));
});

test('a prior guard-only run does not prevent a later fallback', async () => {
  const send = await shouldSend(context, async url => ({ ok: true, json: async () => url.includes('/jobs?')
    ? { jobs: [{ steps: [{ name: 'Send fresh quote to Telegram', status: 'completed', conclusion: 'skipped' }] }] }
    : { workflow_runs: [run(19, '2026-10-27T02:00:00Z')] } }), now);
  assert.equal(send, true);
});
