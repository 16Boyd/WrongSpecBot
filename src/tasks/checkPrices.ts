import supabase from '../lib/supabase';
import Logger from '../lib/logger';
import { getAccessToken, getTokenQuote, REGIONS } from '../lib/blizzard';
import { sendChannelMessage, editChannelMessage, deleteChannelMessage } from '../lib/discord';

function errorToLogMetadata(error: unknown): Record<string, unknown> {
    if (error === null || error === undefined) return { error: null };
    if (typeof error === 'string') return { error, message: error };
    if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
    if (typeof error === 'object') {
        try { return JSON.parse(JSON.stringify(error)); } catch { return { error: String(error) }; }
    }
    return { error: String(error) };
}

function objectToLogMetadata(obj: unknown): Record<string, unknown> {
    if (obj === null || obj === undefined) return {};
    if (typeof obj === 'object') {
        try { return JSON.parse(JSON.stringify(obj)); } catch { return { data: String(obj) }; }
    }
    return { data: obj as unknown };
}

interface NotificationSettings {
    channelId: string;
    lastStatusSignature: string | null;
    lastMessageSignature: string | null;
    lastNotified: number | null;
    messageId: string | null;
}

interface DatabaseNotificationSettings {
    id: string;
    channel_id: string;
    last_status_signature: string | null;
    last_message_signature: string | null;
    last_notified: string | null;
    message_id: string | null;
}

interface TokenPriceRanges {
    four_week_low_copper: number | string | null;
    four_week_high_copper: number | string | null;
    year_low_copper: number | string | null;
    year_high_copper: number | string | null;
    year_sample_count: number | string;
    history_from: string | null;
    has_full_year: boolean;
    has_community_backfill: boolean;
}

interface CheckPricesResult {
    success: boolean;
    timestamp: string;
    error?: string;
}

const UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const COPPER_PER_GOLD = 10000;

type Position = 'UNKNOWN' | 'BELOW_LOW' | 'LOW' | 'AT_BOTH' | 'WITHIN' | 'HIGH' | 'ABOVE_HIGH';
interface RangeBounds { low: number | null; high: number | null; }
interface PriceRanges {
    fourWeek: RangeBounds;
    year: RangeBounds;
    yearSampleCount: number;
    historyFrom: string | null;
    hasFullYear: boolean;
    hasCommunityBackfill: boolean;
}

function defaultSettings(): NotificationSettings {
    return {
        channelId: process.env.DEFAULT_CHANNEL_ID || '',
        lastStatusSignature: null,
        lastMessageSignature: null,
        lastNotified: null,
        messageId: null
    };
}

async function loadNotificationSettings(logger: Logger): Promise<NotificationSettings> {
    try {
        const { data, error } = await supabase
            .from('notification_settings')
            .select('*')
            .eq('id', 'default')
            .single<DatabaseNotificationSettings>();
        if (error && error.code !== 'PGRST116') {
            logger.error('Error loading notification settings', errorToLogMetadata(error));
            return defaultSettings();
        }
        if (!data) return defaultSettings();
        return {
            channelId: data.channel_id || process.env.DEFAULT_CHANNEL_ID || '',
            lastStatusSignature: data.last_status_signature,
            lastMessageSignature: data.last_message_signature,
            lastNotified: data.last_notified ? new Date(data.last_notified).getTime() : null,
            messageId: data.message_id || null
        };
    } catch (error) {
        logger.error('Error loading notification settings', errorToLogMetadata(error));
        return defaultSettings();
    }
}

async function updateNotificationState(
    fields: Partial<Pick<DatabaseNotificationSettings, 'last_status_signature' | 'last_message_signature' | 'last_notified' | 'message_id'>>,
    logger: Logger
): Promise<void> {
    try {
        const { error } = await supabase.from('notification_settings').upsert({
            id: 'default', updated_at: new Date().toISOString(), ...fields
        }, { onConflict: 'id' });
        if (error) logger.error('Error updating notification state', errorToLogMetadata(error));
    } catch (error) {
        logger.error('Error updating notification state', errorToLogMetadata(error));
    }
}

function toNumber(value: number | string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

async function getPriceRanges(region: string, asOf: string): Promise<PriceRanges> {
    const { data, error } = await supabase.rpc('get_token_price_ranges', {
        p_region: region,
        p_as_of: asOf
    });
    if (error) throw new Error(`Could not calculate token price ranges: ${error.message}`);
    const row = Array.isArray(data) ? data[0] as TokenPriceRanges | undefined : data as TokenPriceRanges | null;
    if (!row) throw new Error('Price range function returned no data');
    return {
        fourWeek: {
            low: toNumber(row.four_week_low_copper),
            high: toNumber(row.four_week_high_copper)
        },
        year: {
            low: toNumber(row.year_low_copper),
            high: toNumber(row.year_high_copper)
        },
        yearSampleCount: Number(row.year_sample_count) || 0,
        historyFrom: row.history_from,
        hasFullYear: row.has_full_year,
        hasCommunityBackfill: row.has_community_backfill
    };
}

function classify(price: number, bounds: RangeBounds): Position {
    if (bounds.low === null || bounds.high === null) return 'UNKNOWN';
    if (bounds.low === bounds.high && price === bounds.low) return 'AT_BOTH';
    if (price < bounds.low) return 'BELOW_LOW';
    if (price > bounds.high) return 'ABOVE_HIGH';
    if (price === bounds.low) return 'LOW';
    if (price === bounds.high) return 'HIGH';
    return 'WITHIN';
}

function stablePosition(position: Position): Position {
    // A breakout becomes the new observed extreme after insertion. Treat the next quote at
    // that extreme as the same status so we don't immediately repost a second message.
    if (position === 'ABOVE_HIGH') return 'HIGH';
    if (position === 'BELOW_LOW') return 'LOW';
    return position;
}

function percentDifference(price: number, bound: number): number {
    if (bound === 0) return 0;
    return Math.abs((price - bound) / bound) * 100;
}

function positionText(label: string, price: number, bounds: RangeBounds, breakoutBounds: RangeBounds): string {
    if (bounds.low === null || bounds.high === null) return `${label}: Collecting history`;
    if (bounds.low === bounds.high) {
        if (price === bounds.low) return `${label}: At the only observed price (${formatGold(bounds.low)})`;
        if (price > bounds.high) return `${label}: Above the observed price by ${percentDifference(price, bounds.high).toFixed(2)}%`;
        return `${label}: Below the observed price by ${percentDifference(price, bounds.low).toFixed(2)}%`;
    }
    if (price < bounds.low) return `${label}: **${percentDifference(price, bounds.low).toFixed(2)}% below the low** (${formatGold(bounds.low)})`;
    if (price > bounds.high) return `${label}: **${percentDifference(price, bounds.high).toFixed(2)}% above the high** (${formatGold(bounds.high)})`;
    if (price === bounds.high && breakoutBounds.high !== null && price > breakoutBounds.high) {
        return `${label}: **New high — ${percentDifference(price, breakoutBounds.high).toFixed(2)}% above the prior high** (${formatGold(breakoutBounds.high)})`;
    }
    if (price === bounds.low && breakoutBounds.low !== null && price < breakoutBounds.low) {
        return `${label}: **New low — ${percentDifference(price, breakoutBounds.low).toFixed(2)}% below the prior low** (${formatGold(breakoutBounds.low)})`;
    }
    if (price === bounds.high) return `${label}: At the high (${formatGold(bounds.high)})`;
    if (price === bounds.low) return `${label}: At the low (${formatGold(bounds.low)})`;
    const position = ((price - bounds.low) / (bounds.high - bounds.low)) * 100;
    return `${label}: ${position.toFixed(1)}% of the way from low to high`;
}

function formatGold(copper: number): string {
    return Math.round(copper / COPPER_PER_GOLD).toLocaleString();
}

function buildMessage(
    region: string,
    priceCopper: number,
    ranges: PriceRanges,
    priorRanges: PriceRanges,
): string {
    const coverage = ranges.hasFullYear
        ? `52-week sample window available (observed since ${ranges.historyFrom ? new Date(ranges.historyFrom).toLocaleDateString('en-US', { timeZone: 'UTC' }) : 'the first observation'})`
        : `52-week history is still building (observed since ${ranges.historyFrom ? new Date(ranges.historyFrom).toLocaleDateString('en-US', { timeZone: 'UTC' }) : 'the first observation'})`;
    const sampleCount = ranges.yearSampleCount.toLocaleString();
    return [
        `📊 **WoW Token Price — ${region}**`,
        `Current price: **${formatGold(priceCopper)} gold**`,
        '',
        positionText('Four-week range', priceCopper, ranges.fourWeek, priorRanges.fourWeek),
        ranges.fourWeek.low !== null && ranges.fourWeek.high !== null
            ? `Low: ${formatGold(ranges.fourWeek.low)} gold · High: ${formatGold(ranges.fourWeek.high)} gold`
            : 'Four-week low/high: collecting history',
        '',
        positionText('52-week range', priceCopper, ranges.year, priorRanges.year),
        ranges.year.low !== null && ranges.year.high !== null
            ? `Low: ${formatGold(ranges.year.low)} gold · High: ${formatGold(ranges.year.high)} gold`
            : '52-week low/high: collecting history',
        coverage,
        ranges.hasCommunityBackfill
            ? `History uses ${sampleCount} observed samples, including wowtoken.app community backfill and Blizzard live checks; backfill may omit price changes.`
            : `History uses ${sampleCount} Blizzard live samples only; 52-week extrema build from this bot's observations.`
    ].join('\n');
}

async function recordObservation(region: string, priceCopper: number, sourceUpdatedAt: string | null, observedAt: string): Promise<void> {
    const record = async (sourceKey: string, sourceTimestamp: string | null): Promise<void> => {
        const { error } = await supabase.rpc('record_token_price_observation', {
            p_region: region,
            p_price_copper: priceCopper,
            p_source: 'blizzard',
            p_source_key: sourceKey,
            p_observed_at: observedAt,
            p_source_updated_at: sourceTimestamp
        });
        if (error) throw new Error(`Could not store token price observation: ${error.message}`);
    };

    // Preserve every distinct Blizzard quote update, while also retaining a daily heartbeat.
    // The heartbeat ensures a flat price stays represented after its original event row ages out.
    await record(`event:${sourceUpdatedAt || observedAt}`, sourceUpdatedAt);
    const dayBucket = observedAt.slice(0, 10); // ISO date is a UTC day bucket.
    await record(`heartbeat:${dayBucket}`, null);
}

async function runDailyHistoryCleanup(logger: Logger): Promise<void> {
    const { error, data } = await supabase.rpc('prune_token_price_history');
    if (error) logger.warn('Could not prune old token price history', errorToLogMetadata(error));
    else if (data) logger.info('Pruned token observations older than one year');
}

async function sendMessage(channelId: string, message: string, logger: Logger): Promise<string | undefined> {
    try {
        const messageId = await sendChannelMessage(channelId, { content: message });
        logger.info(`Price status sent to channel ${channelId}`, { messageId });
        return messageId;
    } catch (error) {
        logger.error('Error sending price status', errorToLogMetadata(error));
        return undefined;
    }
}

async function editMessage(channelId: string, messageId: string, message: string, logger: Logger): Promise<boolean> {
    try {
        await editChannelMessage(channelId, messageId, { content: message });
        return true;
    } catch (error) {
        logger.error('Error editing price status', { messageId, channelId, ...errorToLogMetadata(error) });
        return false;
    }
}

async function deleteMessage(channelId: string, messageId: string, logger: Logger): Promise<void> {
    try {
        await deleteChannelMessage(channelId, messageId);
    } catch (error) {
        logger.warn('Could not delete previous price status', { messageId, channelId, ...errorToLogMetadata(error) });
    }
}

async function checkPrices(): Promise<CheckPricesResult> {
    const logger = new Logger('check-prices-task');
    try {
        logger.info('Starting price check...');
        await runDailyHistoryCleanup(logger);

        const region = (process.env.WATCH_REGION || 'US').toUpperCase();
        if (!REGIONS.includes(region)) throw new Error(`Invalid WATCH_REGION: ${region}`);
        const accessToken = await getAccessToken();
        const quote = await getTokenQuote(region, accessToken);
        const now = new Date().toISOString();
        const settings = await loadNotificationSettings(logger);

        const priorRanges = await getPriceRanges(region, now);
        await recordObservation(region, quote.priceCopper, quote.sourceUpdatedAt, now);
        const ranges = await getPriceRanges(region, now);
        const fourWeekComparison = priorRanges.fourWeek.low === null ? ranges.fourWeek : priorRanges.fourWeek;
        const yearComparison = priorRanges.year.low === null ? ranges.year : priorRanges.year;
        const fourWeekPosition = stablePosition(classify(quote.priceCopper, fourWeekComparison));
        const yearPosition = stablePosition(classify(quote.priceCopper, yearComparison));
        const statusSignature = `${fourWeekPosition}|${yearPosition}`;
        const message = buildMessage(region, quote.priceCopper, ranges, priorRanges);
        const messageSignature = message;
        const statusChanged = settings.lastStatusSignature !== statusSignature;
        const messageChanged = settings.lastMessageSignature !== messageSignature;
        const nowMs = Date.now();
        const throttled = settings.lastNotified !== null && nowMs - settings.lastNotified < UPDATE_INTERVAL_MS;

        logger.info('Calculated token price ranges', {
            region,
            currentPriceGold: quote.priceCopper / COPPER_PER_GOLD,
            fourWeekPosition,
            yearPosition,
            hasFullYear: ranges.hasFullYear,
            historySamples: ranges.yearSampleCount,
            statusChanged,
            messageChanged,
            hasExistingMessage: !!settings.messageId
        });

        if (!settings.channelId) {
            logger.warn('No notification channel configured; price observation recorded without posting a message');
            await logger.flush();
            return { success: true, timestamp: new Date().toISOString() };
        }

        if (!settings.messageId || statusChanged) {
            if (settings.messageId) await deleteMessage(settings.channelId, settings.messageId, logger);
            const messageId = await sendMessage(settings.channelId, message, logger);
            if (messageId) {
                await updateNotificationState({
                    message_id: messageId,
                    last_status_signature: statusSignature,
                    last_message_signature: messageSignature,
                    last_notified: now
                }, logger);
            }
        } else if (messageChanged && !throttled) {
            const success = await editMessage(settings.channelId, settings.messageId, message, logger);
            if (success) {
                await updateNotificationState({
                    last_status_signature: statusSignature,
                    last_message_signature: messageSignature,
                    last_notified: now
                }, logger);
            } else {
                logger.warn('Could not edit current price status; clearing stale Discord message ID');
                await updateNotificationState({ message_id: null }, logger);
            }
        } else if (throttled && messageChanged) {
            const waitSeconds = Math.ceil((UPDATE_INTERVAL_MS - (nowMs - (settings.lastNotified || 0))) / 1000);
            logger.info(`Price status edit throttled for ${waitSeconds}s`);
        } else {
            logger.info('Price status unchanged; no Discord edit needed');
        }

        await logger.flush();
        return { success: true, timestamp: new Date().toISOString() };
    } catch (error) {
        logger.error('Error in checkPrices', errorToLogMetadata(error));
        await logger.flush();
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date().toISOString() };
    }
}

export { checkPrices };
