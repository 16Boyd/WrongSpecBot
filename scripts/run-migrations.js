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
    'supabase-server-status.sql'
];

async function main() {
    if (process.env.VERCEL_ENV !== 'production') {
        console.log(`Skipping Supabase migrations (VERCEL_ENV=${process.env.VERCEL_ENV || 'not set'})`);
        return;
    }

    const connectionString = process.env.POSTGRES_URL_NON_POOLING;
    if (!connectionString) {
        console.log('POSTGRES_URL_NON_POOLING not set, skipping Supabase migrations');
        return;
    }

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
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error('Supabase migration failed:', error);
    process.exit(1);
});
