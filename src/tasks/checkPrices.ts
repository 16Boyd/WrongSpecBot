import { Client, GatewayIntentBits, TextChannel, Message, BaseGuildTextChannel } from 'discord.js';
import axios from 'axios';
import supabase from '../lib/supabase';
import Logger from '../lib/logger';

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

// Blizzard API endpoints
const API_ENDPOINTS: Record<string, string> = {
    US: 'https://us.api.blizzard.com/data/wow/token/index',
    EU: 'https://eu.api.blizzard.com/data/wow/token/index',
    KR: 'https://kr.api.blizzard.com/data/wow/token/index',
    TW: 'https://tw.api.blizzard.com/data/wow/token/index'
};

interface AccessTokenResponse {
    access_token: string;
}

// Get access token from Blizzard API
async function getAccessToken(logger: Logger): Promise<string> {
    try {
        logger.info('Getting access token...');
        const response = await axios.post<AccessTokenResponse>('https://oauth.battle.net/token', null, {
            params: {
                grant_type: 'client_credentials'
            },
            auth: {
                username: process.env.BLIZZARD_CLIENT_ID || '',
                password: process.env.BLIZZARD_CLIENT_SECRET || ''
            }
        });
        logger.info('Access token received successfully');
        return response.data.access_token;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error('Error getting access token', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                headers: error.response?.headers
            });
        } else {
            logger.error('Error getting access token', errorToLogMetadata(error));
        }
        throw new Error('Failed to get access token');
    }
}

interface TokenResponse {
    price: number;
}

// Get token price for a region
async function getTokenPrice(region: string, accessToken: string, logger: Logger): Promise<number> {
    try {
        logger.info(`Getting token price for ${region}...`);
        const url = API_ENDPOINTS[region];
        if (!url) {
            throw new Error(`Invalid region: ${region}`);
        }

        const params = {
            namespace: `dynamic-${region.toLowerCase()}`,
            locale: 'en_US',
            access_token: accessToken
        };
        
        logger.info(`Fetching token price from ${url}`, { params });
        
        const response = await axios.get<TokenResponse>(url, { 
            params,
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        logger.info('API response received', {
            status: response.status,
            data: response.data
        });

        if (!response.data || !response.data.price) {
            throw new Error(`Invalid response format: ${JSON.stringify(response.data)}`);
        }
        
        // Convert from copper to gold (1 gold = 10000 copper)
        return response.data.price / 10000;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error(`Error getting token price for ${region}`, {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status,
                headers: error.response?.headers
            });
        } else {
            logger.error(`Error getting token price for ${region}`, errorToLogMetadata(error));
        }
        throw new Error(`Failed to get token price for ${region}`);
    }
}

// Load notification settings from Supabase
async function loadNotificationSettings(logger: Logger): Promise<NotificationSettings> {
    try {
        logger.info('LOAD NOTIFICATION SETTINGS (CHECKPRICES) STARTED');
        
        const { data, error } = await supabase
            .from('notification_settings')
            .select('*')
            .eq('id', 'default')
            .single<DatabaseNotificationSettings>();
        
        if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
            logger.error('Error loading notification settings', errorToLogMetadata(error));
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
        
        const updateData: Partial<DatabaseNotificationSettings> & { id: string; updated_at: string } = {
            id: 'default',
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
        
        const { error } = await supabase
            .from('notification_settings')
            .upsert(updateData, {
                onConflict: 'id'
            });
        
        if (error) {
            logger.error('Error updating notification state', errorToLogMetadata(error));
        } else {
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

// Send notification to Discord channel and return message ID
async function sendNotificationToChannel(channelId: string, message: string, logger: Logger): Promise<string | undefined> {
    try {
        // Create a temporary Discord client for sending messages
        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        await client.login(process.env.DISCORD_TOKEN);
        
        const channel = await client.channels.fetch(channelId);
        if (channel instanceof BaseGuildTextChannel) {
            const sentMessage = await channel.send(message);
            logger.info(`Notification sent to channel ${channelId}`, { messageId: sentMessage.id });
            await client.destroy();
            return sentMessage.id; // Return the message ID
        } else {
            logger.error(`Channel ${channelId} not found or not text-based`);
            await client.destroy();
            return undefined;
        }
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
    let client: Client | undefined;
    try {
        client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        await client.login(process.env.DISCORD_TOKEN);

        const channel = await client.channels.fetch(channelId);
        if (channel instanceof BaseGuildTextChannel) {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            logger.info(`Message ${messageId} deleted in channel ${channelId}`);
            await client.destroy();
            return true;
        } else {
            logger.error(`Channel ${channelId} not found or not text-based`);
            await client.destroy();
            return false;
        }
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
        try {
            if (client) {
                await client.destroy();
            }
        } catch (destroyError) {
            logger.error('Error destroying client', errorToLogMetadata(destroyError));
        }
        return false;
    }
}

// Edit existing Discord message
async function editDiscordMessage(channelId: string, messageId: string, newMessage: string, logger: Logger): Promise<boolean> {
    let client: Client | undefined;
    try {
        // Create a temporary Discord client for editing messages
        client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages
            ]
        });

        await client.login(process.env.DISCORD_TOKEN);
        
        const channel = await client.channels.fetch(channelId);
        if (channel instanceof BaseGuildTextChannel) {
            const message = await channel.messages.fetch(messageId);
            await message.edit(newMessage);
            logger.info(`Message ${messageId} edited in channel ${channelId}`);
            await client.destroy();
            return true;
        } else {
            logger.error(`Channel ${channelId} not found or not text-based`);
            await client.destroy();
            return false;
        }
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
        try {
            if (client) {
                await client.destroy();
            }
                    } catch (destroyError) {
                logger.error('Error destroying client', errorToLogMetadata(destroyError));
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