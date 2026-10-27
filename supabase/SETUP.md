# Supabase market bot deployment

This deployment uses two isolated Edge Functions in the existing TouchLine Supabase project. It does not change the TouchLine application or the C5 SMS code bot. Keep **Verify JWT with legacy secret** enabled for both functions.

## Edge Function secrets

Create these in **Edge Functions → Secrets**. Enter real values only in that encrypted UI, never in source or saved SQL:

| Name | Purpose |
| --- | --- |
| P2P_TELEGRAM_TOKEN | Token for the separate market update bot |
| P2P_CHAT_ID | Telegram group numeric ID |
| P2P_THREAD_ID | BINANCE P2P Rate topic ID |
| MARKETCAP_THREAD_ID | Notes topic ID |
| P2P_CRON_KEY | Random 32-byte-or-longer hourly request key |
| MARKETCAP_CRON_KEY | Different random 32-byte-or-longer daily request key |

SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically to Edge Functions by the project. The service role key stays server-side.

## Private market history

Run once in the SQL Editor:

```sql
create table if not exists public.telegram_market_snapshots (
  snapshot_date date primary key,
  payload jsonb not null,
  sent_at timestamptz,
  message_ids jsonb,
  created_at timestamptz not null default now()
);
alter table public.telegram_market_snapshots enable row level security;
revoke all on public.telegram_market_snapshots from anon, authenticated;
```

The market function uses its server-side service role to read and write this table. It keeps the latest 90 readings in memory when rendering; old database rows may be pruned separately if desired. No client RLS policies are added.

## Vault and Cron

Create three encrypted Vault secrets via **Integrations → Vault → Secrets**:

- `p2p_cron_key`: same value as Edge secret P2P_CRON_KEY.
- `marketcap_cron_key`: same value as Edge secret MARKETCAP_CRON_KEY.
- `p2p_anon_jwt`: project's legacy anon JWT, used only for Edge gateway verification.

Replace PROJECT_REF below with the target Supabase project reference. These statements contain only Vault secret names, never credential values:

```sql
select cron.schedule('telegram-p2p-hourly', '27 * * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/telegram-p2p-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'p2p_anon_jwt'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'p2p_anon_jwt'),
      'x-p2p-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'p2p_cron_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);

select cron.schedule('telegram-marketcap-daily', '37 22 * * *', $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/telegram-marketcap',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'p2p_anon_jwt'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'p2p_anon_jwt'),
      'x-marketcap-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'marketcap_cron_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
```

Both schedules are UTC. To inspect execution, query `cron.job_run_details` and `net._http_response`, and check Edge Function invocations and logs. A pg_cron job marked successful only means it queued an HTTP request; verify the HTTP response too. The daily function accepts `{"preview":true}` to render without posting, and skips a second post after a successful daily send.

