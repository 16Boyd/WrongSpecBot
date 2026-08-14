# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is pnpm (`packageManager: pnpm@8.15.0`); `.nvmrc` pins Node 20.

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

This is a Discord bot for WoW Token price tracking that runs across **two independent deployment surfaces sharing the same `src/` code**, plus a Cloudflare Worker acting as an external scheduler:

1. **Gateway bot (`src/index.ts`)** — a long-running `discord.js` client (used via `pnpm dev`/`pnpm start`, not deployed to Vercel). It dynamically loads command modules from `dist/commands/*.js` at startup and dispatches slash-command interactions to their `execute()`.
2. **Vercel serverless functions (`api/*.ts`)** — the production path. `api/index.ts` is the single Vercel entry (see `vercel.json` routes, all `/api/*` paths rewrite to `api/index.ts`) and manually routes `/api/interactions` to `api/interactions.ts`. Because Vercel functions can't hold a persistent gateway connection, `api/interactions.ts` verifies Discord's HTTP interaction webhook signature itself (`discord-interactions`) and **reimplements** the `/token` and `/notify` command logic inline rather than importing `src/commands/*`. **When fixing bot command behavior, check both `src/commands/*.ts` (gateway bot) and `api/interactions.ts` (serverless) — they are duplicated, not shared.**
3. **Scheduled tasks (`src/tasks/checkPrices.ts`, `src/tasks/checkServerStatus.ts`)** — these ARE imported (not duplicated) by `api/check-prices.ts` and `api/server-status.ts` respectively. Nothing on Vercel triggers these on a schedule by itself; scheduling comes from outside:
   - `cloudflare-cron/src/worker.ts` runs on a `* * * * *` Cron Trigger (`wrangler.toml`) and POSTs to `/api/check-prices` and `/api/server-status` on the deployed Vercel URL, authenticating with `Authorization: Bearer ${CRON_SECRET}`.
   - UptimeRobot is also treated as a valid caller (checked via `User-Agent` containing `UptimeRobot`) so uptime monitoring doubles as a secondary trigger.

Blizzard Game Data API access (OAuth2 client-credentials token, region-scoped token-price lookup, connected-realm status for regions US/EU/KR/TW) lives in `src/lib/blizzard.ts` and is shared by `api/interactions.ts`, `src/commands/token.ts`, `src/tasks/checkPrices.ts`, and `src/tasks/checkServerStatus.ts` — fix it once, there.

### Persistence (Supabase/Postgres, `src/lib/supabase.ts`)

- `notification_settings` — single-row-per-guild-ish config (`id` default `'default'`) for `/notify`: channel, sell/hold thresholds, `message_id`/`current_price` used to edit an existing Discord alert message in place instead of spamming new ones. Loaded/saved through `src/lib/notificationSettings.ts` (shared by `api/interactions.ts` and `src/tasks/checkPrices.ts`).
- `server_status_settings` — realm-watch config: watched realm/region, online state, `last_message_id` (same edit-in-place pattern), and `offline_check_count` which requires **consecutive** failed checks before a realm is announced offline (avoids flapping on transient API errors).
- `logs` — structured application logs. `src/lib/logger.ts`'s `Logger` class buffers log entries per invocation and flushes them to this table (important on Vercel, where `console.log` output is otherwise hard to retain across serverless invocations); it also auto-flushes on error.

### Database schema changes

The three root-level `supabase-*.sql` files (`supabase-setup.sql`, `supabase-migration.sql`, `supabase-server-status.sql`) are the schema source of truth — there is no Supabase CLI / migration-history tooling. They are written idempotently (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and are applied automatically: `vercel.json`'s `buildCommand` runs `scripts/run-migrations.js` on every Vercel build, which re-runs all three files (in that fixed order — later files `ALTER TABLE` on tables earlier ones create) against `POSTGRES_URL_NON_POOLING`. The script no-ops unless `VERCEL_ENV === 'production'`, so preview builds and local `pnpm run build` never touch the live DB. **To change the schema, edit/add a `supabase-*.sql` file (keeping it idempotent) and add new files to the `MIGRATION_FILES` list in `scripts/run-migrations.js`** — pushing to `main` applies it on the next production deploy. Also keep `vercel.json`'s `ignoreCommand` path list in sync with any new SQL file paths, or a schema-only change won't trigger a deploy at all.

### CI/CD (`.github/workflows/deploy.yml`)

On push to `main`, `dorny/paths-filter` decides what to redeploy:
- Changes under `src/commands/**` or `src/deploy-commands.ts` → runs `deploy:discord:only` (re-registers slash commands).
- Changes under `cloudflare-cron/**` → deploys the Worker via `wrangler` from that directory.
- Vercel deployment is **not** part of this workflow — it's handled by Vercel's own Git integration.

### Environment variables

Bot/API code expects: `DISCORD_TOKEN`, `CLIENT_ID`, `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DISCORD_PUBLIC_KEY` (interaction signature verification), `CRON_SECRET` (Cloudflare Worker auth). `cloudflare-cron` needs `CRON_SECRET` and `VERCEL_BASE_URL` as Worker secrets/vars. `scripts/run-migrations.js` (build-time only) needs `POSTGRES_URL_NON_POOLING`, already present as a Vercel project env var via the Supabase integration.
