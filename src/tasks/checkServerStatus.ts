import axios from 'axios';
import supabase from '../lib/supabase';
import Logger from '../lib/logger';
import { getAccessToken } from '../lib/blizzard';
import { sendChannelMessage, deleteChannelMessage } from '../lib/discord';

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
    last_message_id: string | null;
    offline_check_count: number;
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
): Promise<string | null> {
    if (!settings.channel_id) {
        logger.warn('No channel configured for server status notifications');
        return null;
    }

    if (isOnline && !settings.notify_on_online) return 'skipped'; // Skip but consider success
    if (!isOnline && !settings.notify_on_offline) return 'skipped'; // Skip but consider success

    try {
        // Delete the previous message if it exists
        if (settings.last_message_id) {
            try {
                await deleteChannelMessage(settings.channel_id, settings.last_message_id);
                logger.info(`Deleted previous status message: ${settings.last_message_id}`);
            } catch (error) {
                // Message may already be deleted or not found, that's okay
                logger.warn('Could not delete previous message', errorToLogMetadata(error));
            }
        }

        const emoji = isOnline ? '🟢' : '🔴';
        const status = isOnline ? 'ONLINE' : 'OFFLINE';
        const color = isOnline ? 0x00ff00 : 0xff0000;

        const messageId = await sendChannelMessage(settings.channel_id, {
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

        logger.info(`Sent Discord notification for ${realmName} status change, message ID: ${messageId}`);
        return messageId;
    } catch (error) {
        logger.error('Failed to send Discord notification', errorToLogMetadata(error));
        return null;
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

        let accessToken: string;
        try {
            accessToken = await getAccessToken();
        } catch (error) {
            logger.error('Could not authenticate with Blizzard API', errorToLogMetadata(error));
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
        const offlineCheckCount = settings.offline_check_count ?? 0;
        const REQUIRED_OFFLINE_CHECKS = 2; // Require 2 consecutive offline checks before notifying

        let statusChanged = false;
        let shouldNotify = false;
        let newOfflineCount = offlineCheckCount;

        if (isOnline) {
            // Server is online
            if (!previousOnline) {
                // Was offline, now online - notify
                statusChanged = true;
                shouldNotify = true;
                logger.info(`Realm ${settings.watched_realm} is back ONLINE`);
            } else if (offlineCheckCount > 0) {
                // Was accumulating offline checks but recovered before threshold
                logger.info(`Realm ${settings.watched_realm} recovered after ${offlineCheckCount} offline check(s)`);
            }
            newOfflineCount = 0; // Reset counter
        } else {
            // Server appears offline
            newOfflineCount = offlineCheckCount + 1;
            logger.info(`Realm ${settings.watched_realm} offline check ${newOfflineCount}/${REQUIRED_OFFLINE_CHECKS}`);

            if (previousOnline && newOfflineCount >= REQUIRED_OFFLINE_CHECKS) {
                // Was online, now confirmed offline after multiple checks
                statusChanged = true;
                shouldNotify = true;
                logger.info(`Realm ${settings.watched_realm} confirmed OFFLINE after ${newOfflineCount} consecutive checks`);
            }
        }

        // Send notification if needed
        if (shouldNotify) {
            logger.info(`Realm ${settings.watched_realm} status changed: ${previousOnline} -> ${isOnline}`);

            // Send notification first
            const newMessageId = await sendDiscordNotification(
                settings.watched_realm,
                settings.watched_realm_region,
                isOnline,
                settings,
                logger
            );

            // Only update database if notification succeeded
            if (newMessageId) {
                const updateData: Record<string, unknown> = {
                    watched_realm_online: isOnline,
                    offline_check_count: newOfflineCount,
                    updated_at: new Date().toISOString()
                };

                // Only save message ID if it's not 'skipped' (actual message was sent)
                if (newMessageId !== 'skipped') {
                    updateData.last_message_id = newMessageId;
                }

                await supabase
                    .from('server_status_settings')
                    .update(updateData)
                    .eq('id', 'default');

                logger.info('Database updated after successful notification');
            } else {
                logger.warn('Skipping database update - notification failed, will retry next check');
            }
        } else if (newOfflineCount !== offlineCheckCount) {
            // Update just the offline count (no notification needed)
            await supabase
                .from('server_status_settings')
                .update({
                    offline_check_count: newOfflineCount,
                    updated_at: new Date().toISOString()
                })
                .eq('id', 'default');

            logger.info(`Updated offline_check_count to ${newOfflineCount}`);
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
