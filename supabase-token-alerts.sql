-- Durable, user-owned WoW Token alerts. Safe to apply on every production deploy.
CREATE TABLE IF NOT EXISTS token_price_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id TEXT NOT NULL,
    region TEXT NOT NULL CHECK (region IN ('US', 'EU', 'KR', 'TW')),
    direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    target_price NUMERIC NOT NULL CHECK (target_price > 0),
    reset_gap_percent INTEGER NOT NULL DEFAULT 3 CHECK (reset_gap_percent BETWEEN 1 AND 10),
    armed BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
    trigger_count INTEGER NOT NULL DEFAULT 0,
    last_triggered_at TIMESTAMPTZ,
    last_delivery_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_price_alerts_active_region
    ON token_price_alerts (region, status, armed);
CREATE INDEX IF NOT EXISTS idx_token_price_alerts_owner
    ON token_price_alerts (discord_user_id, created_at);

ALTER TABLE token_price_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow backend operations on token_price_alerts" ON token_price_alerts;
DROP POLICY IF EXISTS "Service role operations on token_price_alerts" ON token_price_alerts;
REVOKE ALL ON TABLE token_price_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE token_price_alerts TO service_role;
CREATE POLICY "Service role operations on token_price_alerts"
    ON token_price_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS token_price_alert_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES token_price_alerts(id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    region TEXT NOT NULL CHECK (region IN ('US', 'EU', 'KR', 'TW')),
    direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    target_price NUMERIC NOT NULL,
    current_price NUMERIC NOT NULL,
    reset_gap_percent INTEGER NOT NULL CHECK (reset_gap_percent BETWEEN 1 AND 10),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until TIMESTAMPTZ,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    UNIQUE (alert_id, cycle)
);

CREATE INDEX IF NOT EXISTS idx_token_price_alert_deliveries_queue
    ON token_price_alert_deliveries (status, lease_until, created_at);

ALTER TABLE token_price_alert_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow backend operations on token_price_alert_deliveries" ON token_price_alert_deliveries;
DROP POLICY IF EXISTS "Service role operations on token_price_alert_deliveries" ON token_price_alert_deliveries;
REVOKE ALL ON TABLE token_price_alert_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE token_price_alert_deliveries TO service_role;
CREATE POLICY "Service role operations on token_price_alert_deliveries"
    ON token_price_alert_deliveries FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Row locking makes each price evaluation a single atomic transition even when cron
-- invocations overlap. The delivery row is the transactional outbox for each trigger.
CREATE OR REPLACE FUNCTION evaluate_token_price_alert(p_alert_id UUID, p_current_price NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    alert_row public.token_price_alerts%ROWTYPE;
    delivery_id UUID;
    next_cycle INTEGER;
    should_trigger BOOLEAN;
    should_rearm BOOLEAN;
BEGIN
    SELECT * INTO alert_row FROM public.token_price_alerts WHERE id = p_alert_id FOR UPDATE;
    IF NOT FOUND OR alert_row.status <> 'active' THEN
        RETURN jsonb_build_object('triggered', false);
    END IF;

    IF alert_row.armed THEN
        should_trigger := (alert_row.direction = 'above' AND p_current_price >= alert_row.target_price)
            OR (alert_row.direction = 'below' AND p_current_price <= alert_row.target_price);
        IF NOT should_trigger THEN
            RETURN jsonb_build_object('triggered', false);
        END IF;

        next_cycle := alert_row.trigger_count + 1;
        UPDATE public.token_price_alerts
            SET armed = FALSE, trigger_count = next_cycle, last_triggered_at = NOW(), updated_at = NOW()
            WHERE id = alert_row.id;
        INSERT INTO public.token_price_alert_deliveries (
            alert_id, cycle, discord_user_id, region, direction,
            target_price, current_price, reset_gap_percent
        ) VALUES (
            alert_row.id, next_cycle, alert_row.discord_user_id, alert_row.region,
            alert_row.direction, alert_row.target_price, p_current_price, alert_row.reset_gap_percent
        ) RETURNING id INTO delivery_id;

        RETURN jsonb_build_object(
            'triggered', true, 'id', delivery_id, 'alert_id', alert_row.id,
            'discord_user_id', alert_row.discord_user_id, 'region', alert_row.region,
            'direction', alert_row.direction, 'target_price', alert_row.target_price,
            'current_price', p_current_price, 'reset_gap_percent', alert_row.reset_gap_percent,
            'cycle', next_cycle
        );
    END IF;

    should_rearm := (alert_row.direction = 'above'
            AND p_current_price <= alert_row.target_price * (1 - alert_row.reset_gap_percent::NUMERIC / 100))
        OR (alert_row.direction = 'below'
            AND p_current_price >= alert_row.target_price * (1 + alert_row.reset_gap_percent::NUMERIC / 100));
    IF should_rearm THEN
        UPDATE public.token_price_alerts SET armed = TRUE, updated_at = NOW() WHERE id = alert_row.id;
    END IF;
    RETURN jsonb_build_object('triggered', false);
END;
$$;

REVOKE EXECUTE ON FUNCTION evaluate_token_price_alert(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION evaluate_token_price_alert(UUID, NUMERIC) TO service_role;

-- Claim queue rows atomically so parallel cron runs do not send the same message together.
-- The 3-minute lease exceeds the worst case for the small claim batch (4 rows, with
-- two Discord calls capped at 10 seconds each) while allowing recovery by later cron ticks.
CREATE OR REPLACE FUNCTION claim_token_price_alert_deliveries(p_limit INTEGER DEFAULT 100)
RETURNS SETOF public.token_price_alert_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM public.token_price_alert_deliveries
        WHERE status = 'pending' OR (status = 'sending' AND lease_until < NOW())
        ORDER BY created_at
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.token_price_alert_deliveries AS delivery
        SET status = 'sending', attempts = attempts + 1, lease_until = NOW() + INTERVAL '3 minutes'
        FROM candidates
        WHERE delivery.id = candidates.id
        RETURNING delivery.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_token_price_alert_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_token_price_alert_deliveries(INTEGER) TO service_role;
