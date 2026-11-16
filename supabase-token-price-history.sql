-- Rolling WoW Token ranges use timestamped observations rather than fixed buy/sell thresholds.
CREATE TABLE IF NOT EXISTS token_price_history (
    region TEXT NOT NULL CHECK (region IN ('US', 'EU', 'KR', 'TW')),
    source TEXT NOT NULL CHECK (source IN ('blizzard', 'wowtoken_app_backfill')),
    source_key TEXT NOT NULL,
    price_copper BIGINT NOT NULL CHECK (price_copper > 0),
    observed_at TIMESTAMPTZ NOT NULL,
    source_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (region, source, source_key)
);

CREATE INDEX IF NOT EXISTS idx_token_price_history_region_observed
    ON token_price_history (region, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_price_history_observed
    ON token_price_history (observed_at);

ALTER TABLE token_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations on token_price_history" ON token_price_history;
CREATE POLICY "Allow all operations on token_price_history"
ON token_price_history FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON token_price_history TO anon, authenticated;

-- Track per-region imports. A row is written only after the direct migration connection has
-- transactionally inserted and verified the source data.
CREATE TABLE IF NOT EXISTS token_price_backfill_runs (
    region TEXT PRIMARY KEY CHECK (region IN ('US', 'EU', 'KR', 'TW')),
    imported_at TIMESTAMPTZ NOT NULL,
    observed_from TIMESTAMPTZ NOT NULL,
    observed_to TIMESTAMPTZ NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0)
);

ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS last_status_signature TEXT;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS last_message_signature TEXT;

COMMENT ON TABLE token_price_history IS
    'Sampled historical WoW Token prices. wowtoken_app_backfill values are third-party community history; blizzard values are live API observations.';
COMMENT ON COLUMN notification_settings.last_status_signature IS
    'Combined 4-week and 52-week position classes used to decide when to repost the price message.';
COMMENT ON COLUMN notification_settings.last_message_signature IS
    'Signature of the last successfully rendered price message, used to avoid no-op Discord edits.';

CREATE OR REPLACE FUNCTION record_token_price_observation(
    p_region TEXT,
    p_price_copper BIGINT,
    p_source TEXT,
    p_source_key TEXT,
    p_observed_at TIMESTAMPTZ,
    p_source_updated_at TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID
LANGUAGE SQL
AS $$
    INSERT INTO token_price_history (region, price_copper, source, source_key, observed_at, source_updated_at)
    VALUES (upper(p_region), p_price_copper, p_source, p_source_key, p_observed_at, p_source_updated_at)
    ON CONFLICT (region, source, source_key) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION get_token_price_ranges(
    p_region TEXT,
    p_as_of TIMESTAMPTZ DEFAULT NOW()
) RETURNS TABLE (
    four_week_low_copper BIGINT,
    four_week_high_copper BIGINT,
    year_low_copper BIGINT,
    year_high_copper BIGINT,
    year_sample_count BIGINT,
    history_from TIMESTAMPTZ,
    has_full_year BOOLEAN,
    has_community_backfill BOOLEAN
)
LANGUAGE SQL
STABLE
AS $$
    SELECT
        MIN(price_copper) FILTER (WHERE observed_at >= p_as_of - INTERVAL '28 days'),
        MAX(price_copper) FILTER (WHERE observed_at >= p_as_of - INTERVAL '28 days'),
        MIN(price_copper) FILTER (WHERE observed_at >= p_as_of - INTERVAL '364 days'),
        MAX(price_copper) FILTER (WHERE observed_at >= p_as_of - INTERVAL '364 days'),
        COUNT(*) FILTER (WHERE observed_at >= p_as_of - INTERVAL '364 days'),
        MIN(observed_at),
        COALESCE(MIN(observed_at) <= p_as_of - INTERVAL '364 days', FALSE),
        COALESCE(BOOL_OR(source = 'wowtoken_app_backfill'), FALSE)
    FROM token_price_history
    WHERE region = upper(p_region)
      AND observed_at >= p_as_of - INTERVAL '365 days'
      AND observed_at <= p_as_of;
$$;

CREATE TABLE IF NOT EXISTS token_price_maintenance (
    id TEXT PRIMARY KEY CHECK (id = 'history_prune'),
    last_pruned_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE token_price_maintenance ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION prune_token_price_history() RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    previous_prune TIMESTAMPTZ;
    current_time_utc TIMESTAMPTZ := NOW();
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('token_price_history_prune'));
    SELECT last_pruned_at INTO previous_prune
      FROM token_price_maintenance WHERE id = 'history_prune';

    IF previous_prune IS NOT NULL AND previous_prune > current_time_utc - INTERVAL '1 day' THEN
        RETURN FALSE;
    END IF;

    DELETE FROM token_price_history WHERE observed_at < current_time_utc - INTERVAL '365 days';
    INSERT INTO token_price_maintenance (id, last_pruned_at)
    VALUES ('history_prune', current_time_utc)
    ON CONFLICT (id) DO UPDATE SET last_pruned_at = EXCLUDED.last_pruned_at;
    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION record_token_price_observation(TEXT, BIGINT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_token_price_ranges(TEXT, TIMESTAMPTZ) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_token_price_history() TO anon, authenticated;

-- Remove already-expired rows at migration time as well as from the daily runtime maintenance call.
DELETE FROM token_price_history WHERE observed_at < NOW() - INTERVAL '365 days';
