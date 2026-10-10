# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is pnpm (`packageManager: pnpm@8.15.0`); `.nvmrc` pins Node 22 (`engines.node` is `22.x`).

```bash
pnpm install                     # install deps
pnpm run build                   # tsc: compiles src/**/* -> dist/ (api/ is NOT compiled by this — Vercel builds api/ separately)
pnpm run dev                     # nodemon + ts-node, runs the gateway bot from src/index.ts, watches src/**/*.ts
pnpm start                       # node dist/index.js (production gateway bot)

pnpm run deploy:discord:only     # ts-node src/deploy-commands.ts — registers/refreshes slash commands with Discord
pnpm run deploy:discord          # build + deploy:discord:only
pnpm run deploy:vercel:only      # vercel deploy --prod
pnpm run deploy:vercel           # build + deploy:vercel:only
pnpm run deploy:all              # build + deploy:discord:only + deploy:vercel:only
```

There is no test suite and no lint script in this repo.

The `cloudflare-cron/` directory is a separate pnpm workspace (own `package.json`/`pnpm-lock.yaml`) deployed with `wrangler`; run its scripts from inside `cloudflare-cron/`.

## Architecture

This is a Discord bot — originally for WoW Token price tracking, now also fronting a CubeCoders AMP game-server status/start panel — that runs across **two independent deployment surfaces sharing the same `src/` code**, plus a Cloudflare Worker acting as an external scheduler:

1. **Gateway bot (`src/index.ts`)** — a long-running `discord.js` client (used via `pnpm dev`/`pnpm start`, not deployed to Vercel). It dynamically loads command modules from `dist/commands/*.js` at startup and dispatches slash-command interactions to their `execute()`. `src/commands/notify.ts`'s gateway-mode `execute()` is a stub (real logic only runs serverless); `src/commands/token.ts`'s gateway `execute()` is a full, independent implementation that imports the shared `src/lib/blizzard.ts`.
2. **Vercel serverless functions (`api/*.ts`)** — the production path. `vercel.json` routes `/api/check-prices`, `/api/server-status`, `/api/amp-status`, and `/api/interactions` each to their own file directly; any other `/api/*` path falls through to `api/index.ts` (which currently only re-routes `/api/interactions`, so that catch-all path is effectively dead for the other three). Because Vercel functions can't hold a persistent gateway connection, `api/interactions.ts` verifies Discord's HTTP interaction webhook signature itself (`discord-interactions`, verified against the **raw** request body — the Vercel body parser is disabled via `export const config = { api: { bodyParser: false } }`) and implements `/token`, `/notify`, and `/alert` handling. `/alert` definitions are in `src/commands/alert.ts`, while its serverless command handlers live here. It also handles the AMP "Start Server" button interaction (`custom_id` prefix `amp_start:`). **When fixing `/token`, `/notify`, or `/alert` behavior, check command definitions and the serverless handler; the production logic is not imported from the command modules.**
3. **Scheduled tasks (`src/tasks/checkPrices.ts`, `src/tasks/checkServerStatus.ts`, `src/tasks/checkAmpStatus.ts`)** — these ARE imported (not duplicated) by `api/check-prices.ts`, `api/server-status.ts`, and `api/amp-status.ts` respectively. Nothing on Vercel triggers these on a schedule by itself; scheduling comes from outside:
   - `cloudflare-cron/src/worker.ts` runs on a `* * * * *` Cron Trigger (`wrangler.toml`) and POSTs to all three endpoints on the deployed Vercel URL, authenticating with `Authorization: Bearer ${CRON_SECRET}` and `User-Agent: Cloudflare-Cron-Worker`.
   - Auth is enforced by `src/lib/auth.ts`'s `isCronAuthorized()`: bearer-token-only, and it **fails closed** (returns `false`) if `CRON_SECRET` is unset server-side, rather than matching a literal `"Bearer undefined"`. There is no UptimeRobot User-Agent bypass — that was deliberately removed as a spoofable auth hole (see `git log` on `src/lib/auth.ts`). Don't reintroduce it.
   - Request headers are never logged in these handlers (a previous version logged them and leaked `CRON_SECRET` into the `logs` table).

Shared libs, each fixing one concern once:
- `src/lib/blizzard.ts` — OAuth2 client-credentials token + region-scoped token-price lookup (US/EU/KR/TW). The access token goes in the `Authorization` header only, never a query param (avoids leaking it into Blizzard's own request logs). Used by `api/interactions.ts`, `src/commands/token.ts`, `src/tasks/checkPrices.ts`.
- `src/lib/discord.ts` — one-shot message ops (`sendChannelMessage`, `editChannelMessage`, `deleteChannelMessage`, `deleteInteractionResponse`) via Discord REST (`discord.js`'s `REST` client), not a gateway login. Used everywhere a serverless function needs to touch a Discord message without holding a persistent connection.
- `src/lib/auth.ts` — `isCronAuthorized()`, see above.
- `src/lib/amp.ts` — thin client for the CubeCoders AMP API (`{AMP_URL}/API/<Module>/<Method>`, session via `Authorization: Bearer` header). Handles controller login, listing/finding instances, starting an instance's daemon (`ADSModule/StartInstance`) and its game application (`Core/Start`, which needs an *instance*-scoped session obtained via a proxied login — a controller session alone gets a permission error on proxied calls). `AMP_INSECURE_TLS=true` disables TLS cert verification for AMP calls only (self-signed panel certs), never for Discord/Blizzard/Supabase.
- `src/lib/ampMessage.ts` — renders the AMP status embed from a per-instance template (`{status}`, `{userCount}`, `{maxUsers}`, `{state}`, `{domain}`, `{port}` placeholders; a `{split}` marker splits the body into side-by-side inline-field "columns"), plus `ampMessageSignature()`, a fingerprint used to skip no-op Discord edits.

### AMP status feature

`src/tasks/checkAmpStatus.ts` polls every configured AMP instance (one row per instance in `amp_instance_status`) each cron tick, edits each instance's live status message in place (fingerprinted via `ampMessageSignature` so unchanged state doesn't cause a Discord edit), and shows a "Start Server" button whenever the instance isn't ready/transitioning. Pressing the button (`api/interactions.ts`'s `handleAmpStart`) flips the message to "Start Requested" and fires the actual AMP start via `waitUntil()` (background work Vercel keeps the function alive for) — because the full start chain commonly exceeds Discord's ~3s interaction ACK window. If that background attempt gets frozen by the serverless runtime, `start_pending` on the row tells the next cron tick to perform the start itself as a guaranteed fallback; `start_requested_at` opens a grace window (`START_REQUEST_GRACE_MS`, 2 minutes) during which the cron won't flip the message back to "Offline" while the server is still booting. Ephemeral "Start requested" confirmation messages are cleaned up by the same cron via the `ephemeral_message_cleanup` table, since a serverless function can't sleep for minutes to delete its own reply later.

### Persistence (Supabase/Postgres, `src/lib/supabase.ts`)

- `notification_settings` — single-row config (`id` default `'default'`) for `/notify`: channel, sell/hold thresholds, `message_id`/`current_price` used to edit an existing Discord alert message in place instead of spamming new ones, plus a 5-minute update throttle (`UPDATE_INTERVAL_MS` in `checkPrices.ts`). Settings loading/saving is currently inline in `src/tasks/checkPrices.ts` and `api/interactions.ts` (duplicated, not shared).
- `token_price_alerts` — personal `/alert` records keyed by Discord user ID, with region, above/below target, 1–10% reset gap (default 3%), armed/waiting state, and latest delivery status. The one-minute price task fetches each active alert region once, evaluates the reset hysteresis independently of `/notify`, and sends triggered alerts by DM. Alert management is scoped to the invoking user; a DM failure is visible in `/alert list` and never falls back to a public channel.
- `server_status_settings` — realm-watch config: watched realm/region, online state, `last_message_id` (same edit-in-place pattern), and `offline_check_count` which requires **consecutive** failed checks (`REQUIRED_OFFLINE_CHECKS = 2`) before a realm is announced offline (avoids flapping on transient API errors).
- `amp_instance_status` — one row per watched AMP instance: channel/message IDs, `last_status` fingerprint, `title`/`description_template`/`port` (author-configurable per instance), `start_requested_at`/`start_pending` (see AMP status feature above).
- `ephemeral_message_cleanup` — queue of ephemeral Discord messages (interaction token + `delete_at`) awaiting deletion by the amp-status cron.
- `token_price_alert_deliveries` — durable notification events keyed by alert and trigger cycle, used to claim a threshold crossing once across overlapping cron invocations and track DM delivery. These private tables are accessed only through the server-only service-role client.
- `logs` — structured application logs. `src/lib/logger.ts`'s `Logger` class buffers log entries per invocation and flushes them to this table (important on Vercel, where `console.log` output is otherwise hard to retain across serverless invocations); it also auto-flushes on error.

### Database schema changes

The root-level `supabase-*.sql` files (`supabase-setup.sql`, `supabase-migration.sql`, `supabase-server-status.sql`, `supabase-amp-status.sql`) are the schema source of truth — there is no Supabase CLI / migration-history tooling. They are written idempotently (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and are intended to apply automatically: `vercel.json`'s `buildCommand` runs `scripts/run-migrations.js` on every production Vercel build, which re-runs each listed file (in a fixed order — later files `ALTER TABLE` on tables earlier ones create) against `POSTGRES_URL_NON_POOLING`. The script no-ops unless `VERCEL_ENV === 'production'`, so preview builds and local `pnpm run build` never touch the live DB.

**To change the schema:** edit/add a `supabase-*.sql` file (keeping it idempotent) and add new files to `MIGRATION_FILES` in `scripts/run-migrations.js` — pushing to `main` then applies it on the next production deploy. Also keep `vercel.json`'s `ignoreCommand` path list in sync with any new SQL file paths, or a schema-only change to an unlisted file won't trigger a deploy at all.

### CI/CD (`.github/workflows/deploy.yml`)

On push to `main`, `dorny/paths-filter` decides what to redeploy:
- Changes under `src/commands/**` or `src/deploy-commands.ts` → runs `deploy:discord:only` (re-registers slash commands).
- Changes under `cloudflare-cron/**` → deploys the Worker via `wrangler` from that directory.
- Vercel deployment is **not** part of this workflow — it's handled by Vercel's own Git integration.

### Environment variables

Bot/API code expects: `DISCORD_TOKEN`, `CLIENT_ID`, `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DISCORD_PUBLIC_KEY` (interaction signature verification), `AUTHORIZED_USERS` (comma-separated Discord user IDs allowed to run `/notify`), `CRON_SECRET` (Cloudflare Worker auth), `DEFAULT_CHANNEL_ID` (fallback `/notify` channel), `WATCH_REGION` (defaults to `US`), `NODE_ENV` (gateway bot only logs in when not `production`). Personal `/alert` persistence additionally requires `SUPABASE_SERVICE_ROLE_KEY`; it must remain server-side and is used only by `src/lib/tokenAlerts.ts`, while existing features retain the anon-key client. AMP feature: `AMP_URL`, `AMP_USERNAME`, `AMP_PASSWORD`, `AMP_INSECURE_TLS` (optional, `true`/`1`/`yes` to skip TLS verification for self-signed panel certs). `cloudflare-cron` needs `CRON_SECRET` and `VERCEL_BASE_URL` as Worker secrets/vars. `scripts/run-migrations.js` (build-time only) needs `POSTGRES_URL_NON_POOLING`, already present as a Vercel project env var via the Supabase integration.
