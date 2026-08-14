import { Client, GatewayIntentBits, TextChannel, Message, BaseGuildTextChannel } from 'discord.js';
import Logger, { errorToLogMetadata } from '../lib/logger';
import { getAccessToken, getTokenPrice } from '../lib/blizzard';
import { loadNotificationSettingsRow, saveNotificationSettingsRow, DatabaseNotificationSettings } from '../lib/notificationSettings';

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

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const NOTIFICATION_COOLDOWN = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

interface NotificationSettings {
    channelId: string;
    sellThreshold: number;
    holdThreshold: number;
    lastAction: string | null;
    lastNotified: number | null;
    messageId: string | null;
    currentPrice: number | null;
}

interface CheckPricesResult {
    success: boolean;
    timestamp: string;
    error?: string;
}

// Load notification settings from Supabase
async function loadNotificationSettings(logger: Logger): Promise<NotificationSettings> {
    try {
        logger.info('LOAD NOTIFICATION SETTINGS (CHECKPRICES) STARTED');

        const data = await loadNotificationSettingsRow(logger);

        if (!data) {
            logger.info('No notification settings found, using defaults');
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
        
        logger.info('Raw loaded data', objectToLogMetadata(data));
        
        // Convert lastNotified timestamp to number for comparison
        let lastNotified: number | null = null;
        if (data.last_notified) {
            lastNotified = new Date(data.last_notified).getTime();
            logger.info('Converted lastNotified to timestamp', { lastNotified });
        }
        
        // Map database fields to expected format
        const settings: NotificationSettings = {
            channelId: data.channel_id,
            sellThreshold: data.sell_threshold,
            holdThreshold: data.hold_threshold,
            lastAction: data.last_action,
            lastNotified,
            messageId: data.message_id || null,
            currentPrice: data.current_price
        };
        
        logger.info('Final processed settings', objectToLogMetadata(settings));
        logger.info('LOAD NOTIFICATION SETTINGS (CHECKPRICES) COMPLETED');
        return settings;
    } catch (error) {
        logger.error('LOAD NOTIFICATION SETTINGS (CHECKPRICES) ERROR');
        if (error instanceof Error) {
            logger.error('Error loading notification settings', {
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error loading notification settings', errorToLogMetadata(error));
        }
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
}

// Update notification state (action, message ID, and current price)
async function updateNotificationState(
    action: string | null | undefined,
    messageId: string | null | undefined,
    currentPrice: number | null | undefined,
    logger: Logger
): Promise<void> {
    try {
        logger.info('UPDATE NOTIFICATION STATE STARTED');
        logger.info('State to update', { action, messageId, currentPrice });
        
        const now = new Date().toISOString();

        const updateData: Partial<Omit<DatabaseNotificationSettings, 'id'>> = {
            updated_at: now
        };

        // Only update when value is not null and not undefined
        if (action !== undefined && action !== null) {
            updateData.last_action = action;
            updateData.last_notified = now;
        }
        if (messageId !== undefined && messageId !== null) {
            updateData.message_id = messageId;
        }
        if (currentPrice !== undefined && currentPrice !== null) {
            updateData.current_price = currentPrice;
        }

        const success = await saveNotificationSettingsRow(updateData, logger);

        if (success) {
            logger.info('Notification state updated successfully');
            logger.info('UPDATE NOTIFICATION STATE COMPLETED');
        }
    } catch (error) {
        logger.error('UPDATE NOTIFICATION STATE ERROR');
        if (error instanceof Error) {
            logger.error('Error updating notification state', {
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error updating notification state', errorToLogMetadata(error));
        }
    }
}

// Create a temporary Discord client, run `action` against the resolved text channel, and
// always destroy the client afterward. Returns undefined (and logs) if the channel can't be
// resolved to a text channel; errors thrown by login/fetch/action propagate to the caller.
async function withDiscordChannel<T>(
    channelId: string,
    logger: Logger,
    action: (channel: BaseGuildTextChannel) => Promise<T>
): Promise<T | undefined> {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages
        ]
    });

    try {
        await client.login(process.env.DISCORD_TOKEN);

        const channel = await client.channels.fetch(channelId);
        if (!(channel instanceof BaseGuildTextChannel)) {
            logger.error(`Channel ${channelId} not found or not text-based`);
            return undefined;
        }

        return await action(channel);
    } finally {
        try {
            await client.destroy();
        } catch (destroyError) {
            logger.error('Error destroying client', errorToLogMetadata(destroyError));
        }
    }
}

// Send notification to Discord channel and return message ID
async function sendNotificationToChannel(channelId: string, message: string, logger: Logger): Promise<string | undefined> {
    try {
        return await withDiscordChannel(channelId, logger, async (channel) => {
            const sentMessage = await channel.send(message);
            logger.info(`Notification sent to channel ${channelId}`, { messageId: sentMessage.id });
            return sentMessage.id;
        });
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error sending notification', {
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error sending notification', errorToLogMetadata(error));
        }
        throw error;
    }
}

// Delete existing Discord message
async function deleteDiscordMessage(channelId: string, messageId: string, logger: Logger): Promise<boolean> {
    try {
        const deleted = await withDiscordChannel(channelId, logger, async (channel) => {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            logger.info(`Message ${messageId} deleted in channel ${channelId}`);
            return true;
        });
        return deleted ?? false;
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error deleting message', {
                messageId,
                channelId,
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error deleting message', {
                messageId,
                channelId,
                error
            });
        }
        return false;
    }
}

// Edit existing Discord message
async function editDiscordMessage(channelId: string, messageId: string, newMessage: string, logger: Logger): Promise<boolean> {
    try {
        const edited = await withDiscordChannel(channelId, logger, async (channel) => {
            const message = await channel.messages.fetch(messageId);
            await message.edit(newMessage);
            logger.info(`Message ${messageId} edited in channel ${channelId}`);
            return true;
        });
        return edited ?? false;
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error editing message', {
                messageId,
                channelId,
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error editing message', {
                messageId,
                channelId,
                error
            });
        }
        return false;
    }
}

// Check prices and send notifications
async function checkPrices(): Promise<CheckPricesResult> {
    const logger = new Logger('check-prices-task');
    
    try {
        logger.info('Starting price check...');
        
        // Get access token
        const accessToken = await getAccessToken(logger);
        
        // Load notification settings
        const settings = await loadNotificationSettings(logger);
        
        // Check prices for each region
        for (const region of ['US']) {
            try {
                const price = await getTokenPrice(region, accessToken, logger);
                logger.info(`Price check results for ${region}`, {
                    currentPrice: price,
                    previousPrice: settings.currentPrice,
                    sellThreshold: settings.sellThreshold,
                    holdThreshold: settings.holdThreshold,
                    lastAction: settings.lastAction || 'none',
                    hasExistingMessage: !!settings.messageId
                });
                
                let shouldSendNewMessage = false;
                let shouldUpdateExistingMessage = false;
                let message = '';
                let newAction = settings.lastAction;
                
                // Only send a NEW message when token moves into SELL stage; all other updates edit the existing message
                if (price >= settings.sellThreshold && settings.lastAction !== 'SELL') {
                    // Price is above sell threshold - send new message (previous message will be deleted)
                    shouldSendNewMessage = true;
                    newAction = 'SELL';
                    message = `🚨 **Token Price Alert**\nRegion: ${region}\nCurrent Price: ${price.toLocaleString()} gold\nAction: **SELL** - Price is above threshold of ${settings.sellThreshold.toLocaleString()} gold\nWill notify again when price drops below ${settings.holdThreshold.toLocaleString()} gold`;
                    logger.info('Triggering SELL notification - sending new message');
                } else if (settings.messageId) {
                    // All other updates: edit the existing message (hold zone, between thresholds, or price change)
                    shouldUpdateExistingMessage = true;
                    if (price <= settings.holdThreshold) {
                        newAction = 'BUY';
                    } else if (price >= settings.sellThreshold) {
                        newAction = 'SELL';
                    } else {
                        newAction = settings.lastAction;
                    }

                    let status = 'MONITORING';
                    if (price >= settings.sellThreshold) {
                        status = 'SELL ZONE';
                    } else if (price <= settings.holdThreshold) {
                        status = 'HOLD ZONE';
                    }

                    message = `📊 **Token Price Update**\nRegion: ${region}\nCurrent Price: ${price.toLocaleString()} gold\nStatus: **${status}**\nSell Threshold: ${settings.sellThreshold.toLocaleString()} gold\nHold Threshold: ${settings.holdThreshold.toLocaleString()} gold\n\n*Last updated: ${new Date().toLocaleString()}*`;
                    logger.info('Updating existing message');
                } else {
                    logger.info('No notification needed', {
                        reason: settings.messageId ? 
                            `Price unchanged (${price.toLocaleString()})` : 
                            `Price ${price.toLocaleString()} is between thresholds or same action as last time`,
                        lastAction: settings.lastAction || 'none'
                    });
                }
                
                if (shouldSendNewMessage) {
                    // Delete the previous message before posting the new one (only when entering SELL stage)
                    if (settings.messageId && typeof settings.messageId === 'string') {
                        await deleteDiscordMessage(settings.channelId, settings.messageId, logger);
                        logger.info('Deleted previous message before sending new SELL alert');
                    }
                    logger.info('Sending new notification message...');
                    const messageId = await sendNotificationToChannel(settings.channelId, message, logger);
                    if (messageId) {
                        await updateNotificationState(newAction, messageId, price, logger);
                        logger.info('New message sent and state updated');
                    }
                } else if (shouldUpdateExistingMessage && settings.messageId) {
                    logger.info('Updating existing message...');
                    const messageId = settings.messageId;
                    if (typeof messageId === 'string') {
                        const success = await editDiscordMessage(settings.channelId, messageId, message, logger);
                        if (success) {
                            await updateNotificationState(newAction, messageId, price, logger);
                            logger.info('Existing message updated');
                        } else {
                            logger.warn('Failed to update existing message - it may have been deleted');
                            // Clear the message ID since it's no longer valid
                            await updateNotificationState(undefined, undefined, price, logger);
                        }
                    } else {
                        logger.warn('Invalid message ID type');
                        await updateNotificationState(undefined, undefined, price, logger);
                    }
                } else {
                    // Just update the current price in the database
                    await updateNotificationState(undefined, undefined, price, logger);
                    logger.info('Price recorded in database');
                }
            } catch (error) {
                if (error instanceof Error) {
                    logger.error(`Error checking prices for ${region}`, {
                        message: error.message,
                        stack: error.stack
                    });
                } else {
                    logger.error(`Error checking prices for ${region}`, errorToLogMetadata(error));
                }
            }
        }

        logger.info('Price check completed successfully');
        await logger.flush();
        return { success: true, timestamp: new Date().toISOString() };
    } catch (error) {
        if (error instanceof Error) {
            logger.error('Error in checkPrices', {
                message: error.message,
                stack: error.stack
            });
        } else {
            logger.error('Error in checkPrices', errorToLogMetadata(error));
        }
        await logger.flush();
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date().toISOString() };
    }
}

// Export for serverless function usage
export {
    checkPrices,
    getTokenPrice,
    getAccessToken
}; 