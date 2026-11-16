'use strict';

// Applies the repo's Supabase SQL files to the database as part of the Vercel build.
// Runs only for production deploys, and only when a direct (non-pooled) Postgres
// connection string is available. Every file listed below must be safe to re-run
// (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, etc.) since it runs on
// every production deploy, not just when it last changed.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Order matters: later files may ALTER TABLE on tables created by earlier ones.
const MIGRATION_FILES = [
    'supabase-setup.sql',
    'supabase-migration.sql',
    'supabase-server-status.sql',
    'supabase-amp-status.sql',
    'supabase-token-price-history.sql'
];

const BACKFILL_REGIONS = ['US', 'EU', 'KR', 'TW'];
const BACKFILL_URL = 'https://data.wowtoken.app/v2/relative/retail';
const HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const COPPER_PER_GOLD = 10000;

function isValidHistoricalPoint(point) {
    if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'string') return false;
    const timestamp = Date.parse(point[0]);
    const gold = point[1];
    return Number.isFinite(timestamp) && Number.isSafeInteger(gold) && gold > 0 &&
        Number.isSafeInteger(gold * COPPER_PER_GOLD);
}

async function backfillHistory(client) {
    const cutoff = new Date(Date.now() - HISTORY_RETENTION_MS);

    for (const region of BACKFILL_REGIONS) {
        const { rows } = await client.query(
            'SELECT region FROM token_price_backfill_runs WHERE region = $1',
            [region]
        );
        if (rows.length) {
            console.log(`Historical price backfill already recorded for ${region}`);
            continue;
        }

        try {
            const response = await fetch(`${BACKFILL_URL}/${region.toLowerCase()}/all.json`, {
                signal: AbortSignal.timeout(20000),
                headers: { 'User-Agent': 'WrongSpecBot/rolling-price-history' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const points = await response.json();
            if (!Array.isArray(points) || points.length < 2 || !points.every(isValidHistoricalPoint)) {
                throw new Error('History payload has an invalid shape or contains invalid samples');
            }

            const recentPoints = points
                .map(([timestamp, gold]) => ({ timestamp: new Date(timestamp), gold }))
                .filter(point => point.timestamp >= cutoff && point.timestamp.getTime() <= Date.now())
                .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
            if (recentPoints.length < 2) throw new Error('History feed returned fewer than two samples in the retention window');

            const earliest = recentPoints[0].timestamp;
            const latest = recentPoints[recentPoints.length - 1].timestamp;
            await client.query('BEGIN');
            try {
                for (let offset = 0; offset < recentPoints.length; offset += 500) {
                    const batch = recentPoints.slice(offset, offset + 500);
                    const values = [];
                    const params = [];
                    for (const point of batch) {
                        const base = params.length;
                        params.push(
                            region,
                            'wowtoken_app_backfill',
                            point.timestamp.toISOString(),
                            point.gold * COPPER_PER_GOLD,
                            point.timestamp.toISOString()
                        );
                        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
                    }
                    await client.query(
                        `INSERT INTO token_price_history (region, source, source_key, price_copper, observed_at) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
                        params
                    );
                }

                await client.query(
                    `INSERT INTO token_price_backfill_runs (region, imported_at, observed_from, observed_to, sample_count)
                     VALUES ($1, NOW(), $2, $3, $4)`,
                    [region, earliest.toISOString(), latest.toISOString(), recentPoints.length]
                );
                await client.query('COMMIT');
                console.log(`Imported ${recentPoints.length} sampled historical prices for ${region} from wowtoken.app (${earliest.toISOString()}–${latest.toISOString()})`);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        } catch (error) {
            // Backfill is best-effort: schema deployment can continue, and the bot labels a
            // short or missing history as partial. No import ledger row means a future deploy retries.
            console.warn(`Could not backfill historical prices for ${region}; leaving its history partial for now:`, error instanceof Error ? error.message : error);
        }
    }
}

async function main() {
    if (process.env.VERCEL_ENV !== 'production') {
        console.log(`Skipping Supabase migrations (VERCEL_ENV=${process.env.VERCEL_ENV || 'not set'})`);
        return;
    }

    const rawConnectionString = process.env.POSTGRES_URL_NON_POOLING;
    if (!rawConnectionString) {
        throw new Error('POSTGRES_URL_NON_POOLING is required for a production deploy so database migrations and price-history setup are applied.');
    }

    // pg-connection-string treats a `sslmode=require|prefer|verify-ca` query param on the
    // connection string as an alias for verify-full, which overrides the `ssl.rejectUnauthorized:
    // false` below and fails the connection to Supabase's self-signed pooler cert. Force
    // `no-verify` on the string itself so it can't win that override.
    const connectionUrl = new URL(rawConnectionString);
    connectionUrl.searchParams.set('sslmode', 'no-verify');
    const connectionString = connectionUrl.toString();

    const client = new Client({
        connectionString,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();

    try {
        for (const file of MIGRATION_FILES) {
            const filePath = path.join(__dirname, '..', file);
            const sql = fs.readFileSync(filePath, 'utf8');
            console.log(`Applying ${file}...`);
            await client.query(sql);
            console.log(`Applied ${file}`);
        }
        await client.query("DELETE FROM token_price_history WHERE observed_at < NOW() - INTERVAL '365 days'");
        await backfillHistory(client);
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error('Supabase migration failed:', error);
    process.exit(1);
});
