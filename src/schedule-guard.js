import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MIN_SPACING_MS = 50 * 60 * 1000;

export function recentScheduledRuns(runs, now = new Date(), currentRunId = '') {
  const current = +new Date(now);
  if (!Number.isFinite(current)) throw new Error('Invalid current time');
  return runs.filter(run => {
    const started = Date.parse(run.run_started_at);
    return run.event === 'schedule' && run.status === 'completed'
      && String(run.id) !== String(currentRunId) && Number.isFinite(started)
      && started <= current && current - started < MIN_SPACING_MS;
  });
}

export async function shouldSend(env = process.env, fetchImpl = fetch, now = new Date()) {
  if (env.GITHUB_EVENT_NAME !== 'schedule') return true;
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.GH_TOKEN || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) {
    throw new Error('GitHub schedule context is incomplete');
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/quote.yml/runs?event=schedule&status=completed&per_page=30`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Could not check recent GitHub runs');
  const data = await response.json();
  if (!Array.isArray(data.workflow_runs)) throw new Error('Unexpected GitHub runs response');
  for (const prior of recentScheduledRuns(data.workflow_runs, now, env.GITHUB_RUN_ID)) {
    const jobsResponse = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${prior.id}/jobs?per_page=20`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!jobsResponse.ok) throw new Error('Could not check prior GitHub job');
    const jobs = await jobsResponse.json();
    if (!Array.isArray(jobs.jobs)) throw new Error('Unexpected GitHub jobs response');
    // A failed send can be ambiguous after Telegram receives it; do not risk a duplicate.
    if (jobs.jobs.some(job => job.steps?.some(step => step.name === 'Send fresh quote to Telegram' && step.status !== 'skipped' && step.conclusion !== 'skipped'))) return false;
  }
  return true;
}

async function main() {
  const send = await shouldSend();
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output file is missing');
  await appendFile(process.env.GITHUB_OUTPUT, `send=${send}\n`);
  console.log(send ? 'No recent successful scheduled quote; this run may send.' : 'A scheduled quote succeeded within 50 minutes; skipping this run.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Could not safely decide whether to send a quote'); process.exitCode = 1; });
}
