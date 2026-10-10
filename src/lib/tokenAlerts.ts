import axios from 'axios';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { REGIONS } from './blizzard';

let alertDatabase: SupabaseClient | undefined;

// Alert records contain personal Discord IDs and are not accessible through the
// publishable anon key. This server-only client is lazy so legacy bot features
// continue to use their existing anon-key client/configuration.
function getAlertDatabase(): SupabaseClient {
    if (alertDatabase) return alertDatabase;
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
        throw new Error('Personal alerts require SUPABASE_URL and the server-only SUPABASE_SERVICE_ROLE_KEY');
    }
    alertDatabase = createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
    return alertDatabase;
}

export type AlertDirection = 'above' | 'below';

export interface TokenPriceAlert {
    id: string;
    discord_user_id: string;
    region: string;
    direction: AlertDirection;
    target_price: number;
    reset_gap_percent: number;
    armed: boolean;
    status: 'active';
    last_triggered_at: string | null;
    last_delivery_error: string | null;
}

export interface AlertDelivery {
    id: string;
    alert_id: string;
    discord_user_id: string;
    region: string;
    direction: AlertDirection;
    target_price: number;
    current_price: number;
    reset_gap_percent: number;
    cycle: number;
}

export function getAlertResetPrice(alert: Pick<TokenPriceAlert, 'direction' | 'target_price' | 'reset_gap_percent'>): number {
    const rawResetPrice = alert.direction === 'above'
        ? alert.target_price * (1 - alert.reset_gap_percent / 100)
        : alert.target_price * (1 + alert.reset_gap_percent / 100);
    // Blizzard prices are represented in whole gold. Round the displayed boundary
    // to the nearest value that actually satisfies the inclusive SQL comparison.
    return alert.direction === 'above' ? Math.floor(rawResetPrice) : Math.ceil(rawResetPrice);
}

function botHeaders(): Record<string, string> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('Missing DISCORD_TOKEN environment variable');
    return { Authorization: `Bot ${token}` };
}

// Create the user's DM channel before saving an alert. This verifies the bot can contact
// the user without sending a test message or ever falling back to a public channel.
export async function ensureDirectMessageChannel(userId: string): Promise<string> {
    const response = await axios.post<{ id: string }>(
        'https://discord.com/api/v10/users/@me/channels',
        { recipient_id: userId },
        { headers: botHeaders(), timeout: 10000 }
    );
    return response.data.id;
}

export async function sendDirectMessage(userId: string, content: string, deliveryId: string): Promise<void> {
    const channelId = await ensureDirectMessageChannel(userId);
    // Discord deduplicates matching nonces for a short window. This helps recover
    // when Discord accepted a message but the cron invocation could not persist
    // the delivery result; it does not guarantee exactly-once delivery forever.
    const nonce = deliveryId.replace(/-/g, '').slice(0, 25);
    await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        { content, nonce, enforce_nonce: true },
        { headers: botHeaders(), timeout: 10000 }
    );
}

export function validateAlertInput(input: {
    region: string;
    direction: string;
    targetPrice: number;
    resetGapPercent: number;
}): string | null {
    if (!REGIONS.includes(input.region)) return 'Choose a valid region: US, EU, KR, or TW.';
    if (input.direction !== 'above' && input.direction !== 'below') return 'Choose above or below.';
    if (!Number.isSafeInteger(input.targetPrice) || input.targetPrice < 1) return 'Target price must be a positive whole number of gold.';
    if (!Number.isInteger(input.resetGapPercent) || input.resetGapPercent < 1 || input.resetGapPercent > 10) return 'Reset gap must be a whole percentage from 1% to 10%.';
    return null;
}

export async function createAlert(input: {
    userId: string;
    region: string;
    direction: AlertDirection;
    targetPrice: number;
    resetGapPercent: number;
}): Promise<TokenPriceAlert> {
    const { count, error: countError } = await getAlertDatabase()
        .from('token_price_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('discord_user_id', input.userId)
        .eq('status', 'active');
    if (countError) throw countError;
    if ((count || 0) >= 10) throw new Error('You can have at most 10 active alerts. Remove one before adding another.');

    const { data, error } = await getAlertDatabase()
        .from('token_price_alerts')
        .insert({
            discord_user_id: input.userId,
            region: input.region,
            direction: input.direction,
            target_price: input.targetPrice,
            reset_gap_percent: input.resetGapPercent,
            armed: true,
            status: 'active'
        })
        .select('*')
        .single<TokenPriceAlert>();
    if (error) throw error;
    return data;
}

export async function listAlerts(userId: string): Promise<TokenPriceAlert[]> {
    const { data, error } = await getAlertDatabase()
        .from('token_price_alerts')
        .select('id, discord_user_id, region, direction, target_price, reset_gap_percent, armed, status, last_triggered_at, last_delivery_error')
        .eq('discord_user_id', userId)
        .order('created_at', { ascending: true })
        .returns<TokenPriceAlert[]>();
    if (error) throw error;
    return data || [];
}

export async function removeAlert(userId: string, alertId: string): Promise<boolean> {
    const { data, error } = await getAlertDatabase()
        .from('token_price_alerts')
        .delete()
        .eq('id', alertId)
        .eq('discord_user_id', userId)
        .select('id');
    if (error) throw error;
    return !!data?.length;
}

export async function getActiveAlerts(): Promise<TokenPriceAlert[]> {
    const { data, error } = await getAlertDatabase()
        .from('token_price_alerts')
        .select('id, discord_user_id, region, direction, target_price, reset_gap_percent, armed, status, last_triggered_at, last_delivery_error')
        .eq('status', 'active')
        .returns<TokenPriceAlert[]>();
    if (error) throw error;
    return data || [];
}

export async function evaluateAlert(alertId: string, price: number): Promise<AlertDelivery | null> {
    const { data, error } = await getAlertDatabase().rpc('evaluate_token_price_alert', {
        p_alert_id: alertId,
        p_current_price: price
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    return result?.triggered ? result as AlertDelivery : null;
}

export async function getPendingDeliveries(): Promise<AlertDelivery[]> {
    const { data, error } = await getAlertDatabase().rpc('claim_token_price_alert_deliveries', { p_limit: 4 });
    if (error) throw error;
    return data || [];
}

export async function markDeliverySent(delivery: AlertDelivery): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await getAlertDatabase().from('token_price_alert_deliveries').update({ status: 'sent', delivered_at: now, lease_until: null }).eq('id', delivery.id).eq('status', 'sending');
    if (error) throw error;
    const { error: alertError } = await getAlertDatabase().from('token_price_alerts').update({ last_triggered_at: now, last_delivery_error: null }).eq('id', delivery.alert_id);
    if (alertError) throw alertError;
}

export async function markDeliveryFailed(delivery: AlertDelivery, reason: string): Promise<void> {
    const safeReason = reason.slice(0, 500);
    const { error } = await getAlertDatabase().from('token_price_alert_deliveries').update({ status: 'failed', error: safeReason, lease_until: null }).eq('id', delivery.id).eq('status', 'sending');
    if (error) throw error;
    // Keep the durable alert active and disarmed until its price reset. The failed event is
    // terminal, so a blocked DM is visible in /alert list without retrying every minute.
    const { error: alertError } = await getAlertDatabase().from('token_price_alerts').update({ last_triggered_at: new Date().toISOString(), last_delivery_error: safeReason }).eq('id', delivery.alert_id);
    if (alertError) throw alertError;
}

export function formatDeliveryMessage(delivery: AlertDelivery): string {
    const condition = delivery.direction === 'above' ? 'reached or exceeded' : 'reached or fallen below';
    const resetPrice = getAlertResetPrice(delivery);
    return `🔔 Your WoW Token alert ${condition} ${delivery.target_price.toLocaleString()} gold in ${delivery.region}. Current price: ${Math.round(delivery.current_price).toLocaleString()} gold. It will alert again after the price moves ${delivery.reset_gap_percent}% away (to ${Math.round(resetPrice).toLocaleString()} gold).`;
}
