import supabase from '../lib/supabase';
import Logger from '../lib/logger';
import { getAccessToken, getTokenPriceInGold, REGIONS } from '../lib/blizzard';
import { sendChannelMessage, editChannelMessage, deleteChannelMessage } from '../lib/discord';
import {
    evaluateAlert,
    formatDeliveryMessage,
    getActiveAlerts,
    getPendingDeliveries,
    markDeliveryFailed,
    markDeliverySent,
    sendDirectMessage,
    TokenPriceAlert
} from '../lib/tokenAlerts';

// Utility function to safely convert unknown errors to logger metadata
function errorToLogMetadata(error: unknown): Record<string, unknown> {
    if (error === null || error === undefined) {
        return { error: null };
    }

    if (typeof error === 'string') {
        return { error, message: error };
    }

    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    }

    if (typeof error === 'object') {
        try {
            return JSON.parse(JSON.stringify(error));
        } catch {
            return { error: String(error) };
        }
    }

    return { error: String(error) };
}

// Utility function to safely convert objects to logger metadata
function objectToLogMetadata(obj: unknown): Record<string, unknown> {
    if (obj === null || obj === undefined) {
        return {};
    }

    if (typeof obj === 'object') {
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch {
            return { data: String(obj) };
        }
    }

    return { data: obj as unknown };
}

interface NotificationSettings {
    channelId: string;
    sellThreshold: number;
    holdThreshold: number;
    lastAction: string | null;
    lastNotified: number | null;
    messageId: string | null;
    currentPrice: number | null;
}

interface DatabaseNotificationSettings {
    id: string;
    channel_id: string;
    sell_threshold: number;
    hold_threshold: number;
    last_action: string | null;
    last_notified: string | null;
    message_id: string | null;
    current_price: number | null;
    created_at: string;
    updated_at: string;
}

interface CheckPricesResult {
    success: boolean;
    timestamp: string;
    error?: string;
}

// The worker fires every minute, but we only refresh the live price message at most this often.
const UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function defaultSettings(): NotificationSettings {
    return {
        channelId: process.env.DEFAULT_CHANNEL_ID || '',
        sellThreshold: 250000,
        holdThreshold: 200000,
        lastAction: null,
        lastNotified: null,
        messageId: null,
        currentPrice: null
    };
}

// Load notification settings from Supabase
async function loadNotificationSettings(logger: Logger): Promise<NotificationSettings> {
    try {
        logger.info('Loading notification settings...');

        const { data, error } = await supabase
            .from('notification_settings')
            .select('*')
            .eq('id', 'default')
            .single<DatabaseNotificationSettings>();

        if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
            logger.error('Error loading notification settings', errorToLogMetadata(error));
            return defaultSettings();
        }

        if (!data) {
            logger.info('No notification settings found, using defaults');
            return defaultSettings();
        }

        // Convert lastNotified timestamp to number for comparison
        const lastNotified = data.last_notified ? new Date(data.last_notified).getTime() : null;

        const settings: NotificationSettings = {
            channelId: data.channel_id,
            sellThreshold: data.sell_threshold,
            holdThreshold: data.hold_threshold,
            lastAction: data.last_action,
            lastNotified,
            messageId: data.message_id || null,
            currentPrice: data.current_price
        };

        logger.info('Loaded notification settings', objectToLogMetadata(settings));
        return settings;
    } catch (error) {
        logger.error('Error loading notification settings', errorToLogMetadata(error));
        return defaultSettings();
    }
}

// Update selected notification-state columns. Only the fields provided are written, so a
// caller can explicitly set message_id to null to clear a stale reference.
async function updateNotificationState(
    fields: Partial<Pick<DatabaseNotificationSettings, 'last_action' | 'last_notified' | 'message_id' | 'current_price'>>,
    logger: Logger
): Promise<void> {
    try {
        const updateData = {
            id: 'default',
            updated_at: new Date().toISOString(),
            ...fields
        };

        const { error } = await supabase
            .from('notification_settings')
            .upsert(updateData, { onConflict: 'id' });

        if (error) {
            logger.error('Error updating notification state', errorToLogMetadata(error));
        }
    } catch (error) {
        logger.error('Error updating notification state', errorToLogMetadata(error));
    }
}

// Send a message to a channel and return the new message ID (undefined on failure).
async function sendMessage(channelId: string, message: string, logger: Logger): Promise<string | undefined> {
    try {
        const messageId = await sendChannelMessage(channelId, { content: message });
        logger.info(`Notification sent to channel ${channelId}`, { messageId });
        return messageId;
    } catch (error) {
        logger.error('Error sending notification', errorToLogMetadata(error));
        return undefined;
    }
}

// Edit an existing message. Returns false if the message could not be edited (e.g. deleted).
async function editMessage(channelId: string, messageId: string, message: string, logger: Logger): Promise<boolean> {
    try {
        await editChannelMessage(channelId, messageId, { content: message });
        logger.info(`Message ${messageId} edited in channel ${channelId}`);
        return true;
    } catch (error) {
        logger.error('Error editing message', { messageId, channelId, ...errorToLogMetadata(error) });
        return false;
    }
}

// Delete an existing message (best effort).
async function deleteMessage(channelId: string, messageId: string, logger: Logger): Promise<void> {
    try {
        await deleteChannelMessage(channelId, messageId);
        logger.info(`Message ${messageId} deleted in channel ${channelId}`);
    } catch (error) {
        logger.warn('Could not delete previous message', { messageId, channelId, ...errorToLogMetadata(error) });
    }
}

// Check prices and send notifications
async function checkPrices(): Promise<CheckPricesResult> {
    const logger = new Logger('check-prices-task');

    try {
        logger.info('Starting price check...');

        const settings = await loadNotificationSettings(logger);
        let activeAlerts: TokenPriceAlert[] = [];
        try {
            activeAlerts = await getActiveAlerts();
        } catch (error) {
            logger.error('Could not load personal token alerts', errorToLogMetadata(error));
        }

        const region = (process.env.WATCH_REGION || 'US').toUpperCase();
        if (settings.channelId && !REGIONS.includes(region)) {
            throw new Error(`Invalid WATCH_REGION: ${region}`);
        }
        const regionsToFetch = new Set(activeAlerts.map(alert => alert.region));
        if (settings.channelId) regionsToFetch.add(region);
        const prices = new Map<string, number>();
        if (regionsToFetch.size) {
            try {
                const accessToken = await getAccessToken();
                for (const priceRegion of regionsToFetch) {
                    if (!REGIONS.includes(priceRegion)) {
                        logger.warn(`Skipping alert with invalid region: ${priceRegion}`);
                        continue;
                    }
                    try {
                        prices.set(priceRegion, await getTokenPriceInGold(priceRegion, accessToken));
                    } catch (error) {
                        // One region's API error must not block other regions, queued DMs,
                        // or the existing shared watcher for its own region.
                        logger.error(`Could not fetch WoW Token price for ${priceRegion}`, errorToLogMetadata(error));
                    }
                }
            } catch (error) {
                // Continue to drain already-queued DM events even if Blizzard auth is down.
                logger.error('Could not authenticate with Blizzard for this price check', errorToLogMetadata(error));
            }
        }

        // Each evaluation is a row-locked SQL transition that creates an outbox entry only
        // for the single cron invocation that wins the trigger claim.
        for (const alert of activeAlerts) {
            const currentPrice = prices.get(alert.region);
            if (currentPrice === undefined) continue;
            try {
                await evaluateAlert(alert.id, currentPrice);
            } catch (error) {
                logger.error('Could not evaluate personal token alert', { alertId: alert.id, ...errorToLogMetadata(error) });
            }
        }

        // Claim outbox entries with a lease so parallel cron invocations cannot send the
        // same queued event at once. A failed/blocked DM is marked and shown by /alert list.
        try {
            const deliveries = await getPendingDeliveries();
            // Send serially so multiple alerts for one person do not burst their DM route.
            for (const delivery of deliveries) {
                try {
                    await sendDirectMessage(delivery.discord_user_id, formatDeliveryMessage(delivery), delivery.id);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    logger.error('Personal alert DM failed; alert remains active and will be visible in /alert list', { alertId: delivery.alert_id, ...errorToLogMetadata(error) });
                    try {
                        await markDeliveryFailed(delivery, reason);
                    } catch (recordError) {
                        logger.error('Could not record personal alert delivery failure', { alertId: delivery.alert_id, ...errorToLogMetadata(recordError) });
                    }
                    continue;
                }

                try {
                    await markDeliverySent(delivery);
                    logger.info('Personal alert DM sent', { alertId: delivery.alert_id, deliveryId: delivery.id });
                } catch (error) {
                    // Discord has already accepted the DM. Keep the row leased for recovery;
                    // retrying immediately would risk sending a duplicate.
                    logger.error('DM sent but delivery state could not be recorded', { alertId: delivery.alert_id, deliveryId: delivery.id, ...errorToLogMetadata(error) });
                }
            }
        } catch (error) {
            logger.error('Could not claim personal alert deliveries', errorToLogMetadata(error));
        }

        if (!settings.channelId) {
            logger.info(activeAlerts.length ? 'Personal alerts checked; no shared channel is configured' : 'No shared channel or active personal alerts configured');
            await logger.flush();
            return { success: true, timestamp: new Date().toISOString() };
        }

        const price = prices.get(region);
        if (price === undefined) throw new Error(`Could not fetch the shared watcher price for ${region}`);
        logger.info(`Price check results for ${region}`, {
            currentPrice: price,
            previousPrice: settings.currentPrice,
            sellThreshold: settings.sellThreshold,
            holdThreshold: settings.holdThreshold,
            lastAction: settings.lastAction || 'none',
            hasExistingMessage: !!settings.messageId
        });

        // Determine which zone the current price falls into.
        let zone: 'SELL' | 'BUY' | 'MONITORING' = 'MONITORING';
        if (price >= settings.sellThreshold) {
            zone = 'SELL';
        } else if (price <= settings.holdThreshold) {
            zone = 'BUY';
        }

        const actionable = zone === 'SELL' || zone === 'BUY';
        const newAction = actionable ? zone : settings.lastAction;
        const enteredNewZone = actionable && zone !== settings.lastAction;
        const now = new Date().toISOString();

        if (enteredNewZone) {
            // Price just crossed into SELL or BUY: post a fresh alert, replacing any previous one.
            if (settings.messageId) {
                await deleteMessage(settings.channelId, settings.messageId, logger);
            }

            const message = zone === 'SELL'
                ? `🚨 **Token Price Alert**\nRegion: ${region}\nCurrent Price: ${price.toLocaleString()} gold\nAction: **SELL** - Price is at or above your sell threshold of ${settings.sellThreshold.toLocaleString()} gold`
                : `💰 **Token Price Alert**\nRegion: ${region}\nCurrent Price: ${price.toLocaleString()} gold\nAction: **BUY** - Price is at or below your hold threshold of ${settings.holdThreshold.toLocaleString()} gold`;

            logger.info(`Entering ${zone} zone - sending new alert`);
            const messageId = await sendMessage(settings.channelId, message, logger);
            if (messageId) {
                await updateNotificationState(
                    { last_action: newAction, last_notified: now, message_id: messageId, current_price: price },
                    logger
                );
            }
        } else if (settings.messageId) {
            // A live message already exists. Only edit it when something changed AND at least
            // UPDATE_INTERVAL_MS has passed since the last edit, so the message refreshes at most
            // once every 5 minutes even though the worker runs every minute.
            const priceChanged = settings.currentPrice === null || price !== settings.currentPrice;
            const statusChanged = newAction !== settings.lastAction;
            const msSinceLastUpdate = settings.lastNotified === null ? Infinity : Date.now() - settings.lastNotified;
            const throttled = msSinceLastUpdate < UPDATE_INTERVAL_MS;

            if (!priceChanged && !statusChanged) {
                logger.info('Price unchanged since last check, no update needed');
            } else if (throttled) {
                // Leave current_price/last_notified untouched so the pending change is still
                // reflected on the next tick that clears the 5-minute window.
                const waitSeconds = Math.ceil((UPDATE_INTERVAL_MS - msSinceLastUpdate) / 1000);
                logger.info(`Update throttled - ${waitSeconds}s until the message may be refreshed again`);
            } else {
                const status = zone === 'SELL' ? 'SELL ZONE' : zone === 'BUY' ? 'HOLD ZONE' : 'MONITORING';
                const message = `📊 **Token Price Update**\nRegion: ${region}\nCurrent Price: ${price.toLocaleString()} gold\nStatus: **${status}**\nSell Threshold: ${settings.sellThreshold.toLocaleString()} gold\nHold Threshold: ${settings.holdThreshold.toLocaleString()} gold\n\n*Last updated: ${new Date().toLocaleString()}*`;

                logger.info('Updating existing message');
                const success = await editMessage(settings.channelId, settings.messageId, message, logger);
                if (success) {
                    await updateNotificationState({ last_action: newAction, last_notified: new Date().toISOString(), current_price: price }, logger);
                } else {
                    logger.warn('Failed to edit existing message - clearing stale message ID');
                    // Also clear last_action so the next tick treats the current zone as newly
                    // entered and posts a fresh alert instead of silently staying dark.
                    await updateNotificationState({ message_id: null, last_action: null, current_price: price }, logger);
                }
            }
        } else {
            // No live message and price is between thresholds: just record the current price.
            await updateNotificationState({ current_price: price }, logger);
            logger.info('Price recorded in database');
        }

        logger.info('Price check completed successfully');
        await logger.flush();
        return { success: true, timestamp: new Date().toISOString() };
    } catch (error) {
        logger.error('Error in checkPrices', errorToLogMetadata(error));
        await logger.flush();
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date().toISOString() };
    }
}

// Export for serverless function usage
export { checkPrices };
