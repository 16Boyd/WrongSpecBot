import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import axios from 'axios';
import supabase from '../lib/supabase';
import Logger from '../lib/logger';

function errorToLogMetadata(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }
    return { error: String(error) };
}

interface ServerStatusSettings {
    channel_id: string | null;
    notify_on_offline: boolean;
    notify_on_online: boolean;
    watched_realm: string | null;
    watched_realm_region: string | null;
    watched_realm_online: boolean | null;
}

export interface CheckServerStatusResult {
    success: boolean;
    timestamp: string;
    watchedRealm?: {
        name: string;
        region: string;
        isOnline: boolean;
        statusChanged: boolean;
    };
    error?: string;
}

async function getAccessToken(logger: Logger): Promise<string | null> {
    try {
        const response = await axios.post('https://oauth.battle.net/token', null, {
            params: { grant_type: 'client_credentials' },
            auth: {
                username: process.env.BLIZZARD_CLIENT_ID || '',
                password: process.env.BLIZZARD_CLIENT_SECRET || ''
            },
            timeout: 10000
        });
        return response.data.access_token;
    } catch (error) {
        logger.error('Failed to get access token', errorToLogMetadata(error));
        return null;
    }
}

async function checkRealmStatus(
    realmName: string,
    region: string,
    accessToken: string,
    logger: Logger
): Promise<boolean> {
    try {
        const regionLower = region.toLowerCase();
        const baseUrl = `https://${regionLower}.api.blizzard.com`;
        
        // Convert realm name to slug (lowercase, spaces to hyphens)
        const realmSlug = realmName.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '');
        
        logger.info(`Checking realm status for ${realmName} (slug: ${realmSlug})`);
        
        // Get the realm directly by slug
        const realmResponse = await axios.get(`${baseUrl}/data/wow/realm/${realmSlug}`, {
            params: {
                namespace: `dynamic-${regionLower}`,
                locale: 'en_US'
            },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });
        
        // Extract connected realm ID from the href
        const connectedRealmHref = realmResponse.data.connected_realm?.href;
        if (!connectedRealmHref) {
            logger.warn(`No connected realm found for ${realmName}`);
            return false;
        }
        
        // Get connected realm status
        const connectedRealmResponse = await axios.get(connectedRealmHref, {
            params: {
                namespace: `dynamic-${regionLower}`,
                locale: 'en_US'
            },
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });
        
        const status = connectedRealmResponse.data.status?.type;
        logger.info(`Realm ${realmName} (${region}) status: ${status}`);
        
        return status === 'UP';
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            logger.warn(`Realm "${realmName}" not found in ${region}`);
        } else {
            logger.warn(`Realm ${realmName} check failed`, errorToLogMetadata(error));
        }
        return false;
    }
}

async function getSettings(logger: Logger): Promise<ServerStatusSettings | null> {
    const { data, error } = await supabase
        .from('server_status_settings')
        .select('*')
        .eq('id', 'default')
        .single();
    
    if (error) {
        logger.error('Failed to get server status settings', errorToLogMetadata(error));
        return null;
    }
    
    return data;
}

async function sendDiscordNotification(
    realmName: string,
    region: string,
    isOnline: boolean,
    settings: ServerStatusSettings,
    logger: Logger
): Promise<void> {
    if (!settings.channel_id) {
        logger.warn('No channel configured for server status notifications');
        return;
    }
    
    if (isOnline && !settings.notify_on_online) return;
    if (!isOnline && !settings.notify_on_offline) return;
    
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    
    try {
        await client.login(process.env.DISCORD_TOKEN);
        
        const channel = await client.channels.fetch(settings.channel_id);
        if (!channel || !(channel instanceof TextChannel)) {
            logger.error('Invalid channel for server status notifications');
            return;
        }
        
        const emoji = isOnline ? '🟢' : '🔴';
        const status = isOnline ? 'ONLINE' : 'OFFLINE';
        const color = isOnline ? 0x00ff00 : 0xff0000;
        
        await channel.send({
            embeds: [{
                title: `${emoji} ${realmName} is ${status}`,
                description: isOnline 
                    ? `The ${realmName} (${region}) realm is now back online!`
                    : `The ${realmName} (${region}) realm appears to be offline or under maintenance.`,
                color,
                timestamp: new Date().toISOString(),
                footer: { text: 'WoW Server Status Monitor' }
            }]
        });
        
        logger.info(`Sent Discord notification for ${realmName} status change`);
    } catch (error) {
        logger.error('Failed to send Discord notification', errorToLogMetadata(error));
    } finally {
        await client.destroy();
    }
}

export async function checkServerStatus(): Promise<CheckServerStatusResult> {
    const logger = new Logger('check-server-status');
    
    try {
        logger.info('Starting server status check...');
        
        const settings = await getSettings(logger);
        if (!settings?.watched_realm || !settings?.watched_realm_region) {
            logger.info('No watched realm configured, skipping');
            return {
                success: true,
                timestamp: new Date().toISOString()
            };
        }
        
        const accessToken = await getAccessToken(logger);
        if (!accessToken) {
            return {
                success: false,
                timestamp: new Date().toISOString(),
                error: 'Could not authenticate with Blizzard API'
            };
        }
        
        const isOnline = await checkRealmStatus(
            settings.watched_realm,
            settings.watched_realm_region,
            accessToken,
            logger
        );
        
        const previousOnline = settings.watched_realm_online ?? true;
        const statusChanged = isOnline !== previousOnline;
        
        // Update status in database
        if (statusChanged) {
            await supabase
                .from('server_status_settings')
                .update({ 
                    watched_realm_online: isOnline,
                    updated_at: new Date().toISOString()
                })
                .eq('id', 'default');
            
            logger.info(`Realm ${settings.watched_realm} status changed: ${previousOnline} -> ${isOnline}`);
            
            // Send notification
            await sendDiscordNotification(
                settings.watched_realm,
                settings.watched_realm_region,
                isOnline,
                settings,
                logger
            );
        }
        
        await logger.flush();
        
        return {
            success: true,
            timestamp: new Date().toISOString(),
            watchedRealm: {
                name: settings.watched_realm,
                region: settings.watched_realm_region,
                isOnline,
                statusChanged
            }
        };
    } catch (error) {
        logger.error('Error during server status check', errorToLogMetadata(error));
        await logger.flush();
        
        return {
            success: false,
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
