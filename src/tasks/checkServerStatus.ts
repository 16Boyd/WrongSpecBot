import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
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

// Regions to check
const REGIONS = ['US', 'EU', 'KR', 'TW'] as const;
type Region = typeof REGIONS[number];

// Blizzard API endpoints to check for each region
const REGION_ENDPOINTS: Record<Region, string> = {
    US: 'https://us.api.blizzard.com/data/wow/token/index',
    EU: 'https://eu.api.blizzard.com/data/wow/token/index',
    KR: 'https://kr.api.blizzard.com/data/wow/token/index',
    TW: 'https://tw.api.blizzard.com/data/wow/token/index'
};

// How many consecutive failures before we consider a server offline
const FAILURE_THRESHOLD = 2;

interface ServerStatus {
    id: number;
    region: string;
    is_online: boolean;
    last_checked: string;
    last_status_change: string;
    consecutive_failures: number;
}

interface ServerStatusSettings {
    channel_id: string | null;
    notify_on_offline: boolean;
    notify_on_online: boolean;
    watched_realm: string | null;
    watched_realm_region: string | null;
    watched_realm_online: boolean | null;
}

interface AccessTokenResponse {
    access_token: string;
}

export interface CheckServerStatusResult {
    success: boolean;
    timestamp: string;
    results: {
        region: string;
        isOnline: boolean;
        statusChanged: boolean;
    }[];
    watchedRealm?: {
        name: string;
        region: string;
        isOnline: boolean;
        statusChanged: boolean;
    };
    error?: string;
}

interface RealmSearchResult {
    realms: {
        id: number;
        slug: string;
        name: string;
    }[];
}

interface ConnectedRealmData {
    id: number;
    status: {
        type: string;  // "UP" or "DOWN"
        name: string;
    };
    realms: {
        id: number;
        name: string;
        slug: string;
    }[];
}

// Get access token from Blizzard API
async function getAccessToken(logger: Logger): Promise<string | null> {
    try {
        const response = await axios.post<AccessTokenResponse>('https://oauth.battle.net/token', null, {
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

// Check if a specific region is online
async function checkRegionStatus(region: Region, accessToken: string, logger: Logger): Promise<boolean> {
    try {
        const endpoint = REGION_ENDPOINTS[region];
        const response = await axios.get(endpoint, {
            params: {
                namespace: `dynamic-${region.toLowerCase()}`,
                locale: 'en_US'
            },
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        });
        
        // If we get a successful response, the server is online
        return response.status === 200;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            // 503 Service Unavailable typically means maintenance
            // 504 Gateway Timeout could mean server issues
            // Network errors mean we can't reach the server
            logger.warn(`Region ${region} check failed`, {
                status: error.response?.status,
                message: error.message
            });
        }
        return false;
    }
}

// Check if a specific realm is online
async function checkRealmStatus(
    realmName: string,
    region: string,
    accessToken: string,
    logger: Logger
): Promise<{ isOnline: boolean; realmSlug: string | null }> {
    try {
        const regionLower = region.toLowerCase();
        const baseUrl = `https://${regionLower}.api.blizzard.com`;
        
        // First, search for the realm to get its connected realm ID
        const searchResponse = await axios.get<RealmSearchResult>(`${baseUrl}/data/wow/search/realm`, {
            params: {
                namespace: `dynamic-${regionLower}`,
                'name.en_US': realmName,
                _pageSize: 1
            },
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        });
        
        if (!searchResponse.data.realms || searchResponse.data.realms.length === 0) {
            logger.warn(`Realm "${realmName}" not found in ${region}`);
            return { isOnline: false, realmSlug: null };
        }
        
        const realm = searchResponse.data.realms[0];
        
        // Now get the connected realm status
        const realmResponse = await axios.get<ConnectedRealmData>(
            `${baseUrl}/data/wow/connected-realm/${realm.id}`,
            {
                params: {
                    namespace: `dynamic-${regionLower}`,
                    locale: 'en_US'
                },
                headers: {
                    Authorization: `Bearer ${accessToken}`
                },
                timeout: 15000
            }
        );
        
        const status = realmResponse.data.status?.type;
        const isOnline = status === 'UP';
        
        logger.info(`Realm ${realmName} (${region}) status: ${status}`, {
            realmId: realm.id,
            realmSlug: realm.slug,
            status
        });
        
        return { isOnline, realmSlug: realm.slug };
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.warn(`Realm ${realmName} check failed`, {
                status: error.response?.status,
                message: error.message
            });
        } else {
            logger.error(`Realm ${realmName} check error`, errorToLogMetadata(error));
        }
        return { isOnline: false, realmSlug: null };
    }
}

// Get current status from database
async function getCurrentStatus(logger: Logger): Promise<Map<string, ServerStatus>> {
    const { data, error } = await supabase
        .from('server_status')
        .select('*');
    
    if (error) {
        logger.error('Failed to get current status from database', errorToLogMetadata(error));
        throw error;
    }
    
    const statusMap = new Map<string, ServerStatus>();
    for (const status of data || []) {
        statusMap.set(status.region, status);
    }
    
    return statusMap;
}

// Update status in database
async function updateStatus(
    region: string,
    isOnline: boolean,
    currentStatus: ServerStatus | undefined,
    logger: Logger
): Promise<boolean> {
    const now = new Date().toISOString();
    let statusChanged = false;
    
    if (!currentStatus) {
        // Insert new status
        const { error } = await supabase
            .from('server_status')
            .insert({
                region,
                is_online: isOnline,
                last_checked: now,
                last_status_change: now,
                consecutive_failures: isOnline ? 0 : 1
            });
        
        if (error) {
            logger.error(`Failed to insert status for ${region}`, errorToLogMetadata(error));
        }
        return true; // New status is considered a change
    }
    
    // Calculate new consecutive failures
    let consecutiveFailures = currentStatus.consecutive_failures;
    if (isOnline) {
        consecutiveFailures = 0;
    } else {
        consecutiveFailures = (currentStatus.consecutive_failures || 0) + 1;
    }
    
    // Determine if we should change the status
    // Only mark as offline after FAILURE_THRESHOLD consecutive failures
    const wasOnline = currentStatus.is_online;
    const shouldBeOnline = isOnline || consecutiveFailures < FAILURE_THRESHOLD;
    
    if (wasOnline !== shouldBeOnline) {
        statusChanged = true;
        
        // Record in history
        const durationSeconds = Math.floor(
            (new Date(now).getTime() - new Date(currentStatus.last_status_change).getTime()) / 1000
        );
        
        await supabase
            .from('server_status_history')
            .insert({
                region,
                is_online: shouldBeOnline,
                changed_at: now,
                duration_seconds: durationSeconds
            });
        
        logger.info(`Server status changed for ${region}`, {
            wasOnline,
            isNowOnline: shouldBeOnline,
            durationSeconds
        });
    }
    
    // Update current status
    const { error } = await supabase
        .from('server_status')
        .update({
            is_online: shouldBeOnline,
            last_checked: now,
            last_status_change: statusChanged ? now : currentStatus.last_status_change,
            consecutive_failures: consecutiveFailures,
            updated_at: now
        })
        .eq('region', region);
    
    if (error) {
        logger.error(`Failed to update status for ${region}`, errorToLogMetadata(error));
    }
    
    return statusChanged;
}

// Get notification settings
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

interface StatusChange {
    region: string;
    isOnline: boolean;
    isRealm?: boolean;  // If true, this is a specific realm, not a region
    realmName?: string; // Name of the specific realm
}

// Send a single consolidated Discord notification for all status changes
async function sendDiscordNotification(
    changes: StatusChange[],
    settings: ServerStatusSettings,
    logger: Logger
): Promise<void> {
    if (!settings.channel_id) {
        logger.warn('No channel configured for server status notifications');
        return;
    }
    
    if (changes.length === 0) return;
    
    // Filter changes based on notification settings
    const filteredChanges = changes.filter(change => {
        if (change.isOnline && !settings.notify_on_online) return false;
        if (!change.isOnline && !settings.notify_on_offline) return false;
        return true;
    });
    
    if (filteredChanges.length === 0) return;
    
    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });
    
    try {
        await client.login(process.env.DISCORD_TOKEN);
        
        const channel = await client.channels.fetch(settings.channel_id);
        if (!channel || !(channel instanceof TextChannel)) {
            logger.error('Invalid channel for server status notifications');
            return;
        }
        
        // Build the status lines for each region/realm
        const statusLines = filteredChanges.map(change => {
            const emoji = change.isOnline ? '🟢' : '🔴';
            const status = change.isOnline ? 'Online' : 'Offline';
            if (change.isRealm && change.realmName) {
                return `${emoji} **${change.realmName}** (${change.region}): ${status}`;
            }
            return `${emoji} **${change.region}**: ${status}`;
        });
        
        // Determine overall status for embed color and title
        const anyOffline = filteredChanges.some(c => !c.isOnline);
        const anyOnline = filteredChanges.some(c => c.isOnline);
        
        let title: string;
        let color: number;
        let description: string;
        
        if (anyOffline && anyOnline) {
            title = '⚠️ WoW Server Status Changed';
            color = 0xffaa00; // Orange
            description = 'Some World of Warcraft servers have changed status:';
        } else if (anyOffline) {
            title = '🔴 WoW Servers Offline';
            color = 0xff0000; // Red
            description = 'World of Warcraft servers appear to be offline or under maintenance:';
        } else {
            title = '🟢 WoW Servers Back Online';
            color = 0x00ff00; // Green
            description = 'World of Warcraft servers are now back online:';
        }
        
        await channel.send({
            embeds: [{
                title,
                description: `${description}\n\n${statusLines.join('\n')}`,
                color,
                timestamp: new Date().toISOString(),
                footer: {
                    text: 'WoW Server Status Monitor'
                }
            }]
        });
        
        logger.info('Sent Discord notification for status changes', {
            changes: filteredChanges
        });
    } catch (error) {
        logger.error('Failed to send Discord notification', errorToLogMetadata(error));
    } finally {
        await client.destroy();
    }
}

// Main function to check all server statuses
export async function checkServerStatus(): Promise<CheckServerStatusResult> {
    const logger = new Logger('check-server-status');
    const results: CheckServerStatusResult['results'] = [];
    
    try {
        logger.info('Starting server status check...');
        
        // Get access token
        const accessToken = await getAccessToken(logger);
        if (!accessToken) {
            // If we can't get a token, we can't check status
            // But this might mean Blizzard's auth is down, not the game servers
            logger.warn('Could not get access token, skipping status check');
            return {
                success: false,
                timestamp: new Date().toISOString(),
                results: [],
                error: 'Could not authenticate with Blizzard API'
            };
        }
        
        // Get current status from database
        const currentStatuses = await getCurrentStatus(logger);
        
        // Get notification settings
        const settings = await getSettings(logger);
        
        // Collect all status changes for a single notification
        const statusChanges: StatusChange[] = [];
        
        // Check each region
        for (const region of REGIONS) {
            const isOnline = await checkRegionStatus(region, accessToken, logger);
            const currentStatus = currentStatuses.get(region);
            const statusChanged = await updateStatus(region, isOnline, currentStatus, logger);
            
            const effectiveOnline = isOnline || (currentStatus?.consecutive_failures || 0) < FAILURE_THRESHOLD;
            
            results.push({
                region,
                isOnline: effectiveOnline,
                statusChanged
            });
            
            // Collect status change for consolidated notification
            if (statusChanged) {
                statusChanges.push({ region, isOnline: effectiveOnline });
            }
        }
        
        // Check watched realm if configured
        let watchedRealmResult: CheckServerStatusResult['watchedRealm'] = undefined;
        
        if (settings?.watched_realm && settings?.watched_realm_region) {
            const { isOnline: realmOnline } = await checkRealmStatus(
                settings.watched_realm,
                settings.watched_realm_region,
                accessToken,
                logger
            );
            
            const previousRealmOnline = settings.watched_realm_online ?? true;
            const realmStatusChanged = realmOnline !== previousRealmOnline;
            
            watchedRealmResult = {
                name: settings.watched_realm,
                region: settings.watched_realm_region,
                isOnline: realmOnline,
                statusChanged: realmStatusChanged
            };
            
            // Update the watched realm status in settings
            if (realmStatusChanged) {
                await supabase
                    .from('server_status_settings')
                    .update({ 
                        watched_realm_online: realmOnline,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', 'default');
                
                // Add to status changes for notification
                statusChanges.push({
                    region: settings.watched_realm_region,
                    isOnline: realmOnline,
                    isRealm: true,
                    realmName: settings.watched_realm
                });
                
                logger.info(`Watched realm ${settings.watched_realm} status changed`, {
                    wasOnline: previousRealmOnline,
                    isNowOnline: realmOnline
                });
            }
        }
        
        // Send a single consolidated notification for all changes
        if (statusChanges.length > 0 && settings) {
            await sendDiscordNotification(statusChanges, settings, logger);
        }
        
        logger.info('Server status check completed', {
            results,
            watchedRealm: watchedRealmResult
        });
        
        await logger.flush();
        
        return {
            success: true,
            timestamp: new Date().toISOString(),
            results,
            watchedRealm: watchedRealmResult
        };
    } catch (error) {
        logger.error('Error during server status check', errorToLogMetadata(error));
        await logger.flush();
        
        return {
            success: false,
            timestamp: new Date().toISOString(),
            results,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
