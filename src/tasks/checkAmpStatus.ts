import supabase from '../lib/supabase';
import Logger from '../lib/logger';
import { login, getInstance, getPlayerCount, appStateLabel, AmpInstance } from '../lib/amp';
import { sendChannelMessage, editChannelMessage, MessageBody } from '../lib/discord';

function errorToLogMetadata(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }
    return { error: String(error) };
}

interface AmpStatusSettings {
    channel_id: string | null;
    instance_id: string | null;
    message_id: string | null;
    last_status: string | null;
}

export interface CheckAmpStatusResult {
    success: boolean;
    timestamp: string;
    instance?: {
        name: string;
        running: boolean;
        state: string;
        updated: boolean;
    };
    error?: string;
}

// AppStates where the instance is mid-transition; we hide the Start button so a user
// can't fire a redundant start while one is already in flight.
const TRANSITIONAL_STATES = [5, 7, 10, 30, 40, 70, 75];

async function getSettings(logger: Logger): Promise<AmpStatusSettings | null> {
    const { data, error } = await supabase
        .from('amp_instance_status')
        .select('*')
        .eq('id', 'default')
        .single();

    if (error) {
        logger.error('Failed to get AMP status settings', errorToLogMetadata(error));
        return null;
    }
    return data;
}

async function updateSettings(fields: Partial<AmpStatusSettings>, logger: Logger): Promise<void> {
    const { error } = await supabase
        .from('amp_instance_status')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', 'default');

    if (error) {
        logger.error('Failed to update AMP status settings', errorToLogMetadata(error));
    }
}

// A compact fingerprint of everything we render, so we only edit the Discord message
// when something visible actually changed (avoids a Discord API write every minute).
function statusSignature(instance: AmpInstance): string {
    const players = getPlayerCount(instance);
    const endpoints = (instance.ApplicationEndpoints ?? [])
        .map(e => `${e.DisplayName}=${e.Endpoint}`)
        .join(',');
    return [
        instance.Running,
        instance.AppState,
        players ? `${players.online}/${players.max}` : 'n/a',
        endpoints
    ].join('|');
}

function buildMessage(instance: AmpInstance): MessageBody {
    const running = instance.Running;
    const isTransitioning = TRANSITIONAL_STATES.includes(instance.AppState);
    const showStart = !running && !isTransitioning;

    const emoji = running ? '🟢' : isTransitioning ? '🟡' : '🔴';
    const color = running ? 0x00ff00 : isTransitioning ? 0xffcc00 : 0xff0000;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
        { name: 'Game', value: instance.Module || 'Unknown', inline: true },
        { name: 'Status', value: appStateLabel(instance.AppState), inline: true }
    ];

    const players = getPlayerCount(instance);
    if (players) {
        fields.push({ name: 'Players Online', value: `${players.online} / ${players.max}`, inline: true });
    }

    const endpoints = instance.ApplicationEndpoints ?? [];
    if (endpoints.length > 0) {
        fields.push({
            name: 'Server Info',
            value: endpoints.map(e => `**${e.DisplayName}:** \`${e.Endpoint}\``).join('\n'),
            inline: false
        });
    }

    const body: MessageBody = {
        embeds: [{
            title: `${emoji} ${instance.FriendlyName}`,
            description: running
                ? 'The server is online and accepting players.'
                : showStart
                    ? 'The server is currently stopped. Press **Start Server** to bring it online.'
                    : 'The server is changing state, please wait…',
            color,
            fields,
            timestamp: new Date().toISOString(),
            footer: { text: 'AMP Instance Status' }
        }],
        // Always send a components array so an edit clears the button once the server is running.
        components: showStart
            ? [{
                type: 1, // Action row
                components: [{
                    type: 2, // Button
                    style: 3, // Success (green)
                    label: 'Start Server',
                    emoji: { name: '▶️' },
                    custom_id: `amp_start:${instance.InstanceID}`
                }]
            }]
            : []
    };

    return body;
}

export async function checkAmpStatus(): Promise<CheckAmpStatusResult> {
    const logger = new Logger('check-amp-status');

    try {
        logger.info('Starting AMP instance status check...');

        const settings = await getSettings(logger);
        if (!settings?.channel_id || !settings?.instance_id) {
            logger.info('No AMP channel or instance configured, skipping');
            await logger.flush();
            return { success: true, timestamp: new Date().toISOString() };
        }

        const sessionId = await login();
        const instance = await getInstance(sessionId, settings.instance_id);

        if (!instance) {
            logger.warn(`AMP instance ${settings.instance_id} not found`);
            await logger.flush();
            return {
                success: false,
                timestamp: new Date().toISOString(),
                error: 'Configured AMP instance not found'
            };
        }

        const signature = statusSignature(instance);
        const message = buildMessage(instance);

        let updated = false;

        if (!settings.message_id) {
            // No live message yet: post a fresh one.
            const messageId = await sendChannelMessage(settings.channel_id, message);
            await updateSettings({ message_id: messageId, last_status: signature }, logger);
            updated = true;
            logger.info(`Posted new AMP status message: ${messageId}`);
        } else if (signature !== settings.last_status) {
            // Something visible changed: edit in place so the message stays put in the channel.
            try {
                await editChannelMessage(settings.channel_id, settings.message_id, message);
                await updateSettings({ last_status: signature }, logger);
                updated = true;
                logger.info(`Edited AMP status message: ${settings.message_id}`);
            } catch (error) {
                // The message was likely deleted; drop the reference so the next tick reposts it.
                logger.warn('Could not edit AMP status message - clearing stale message ID', errorToLogMetadata(error));
                await updateSettings({ message_id: null }, logger);
            }
        } else {
            logger.info('AMP status unchanged since last check, no update needed');
        }

        await logger.flush();
        return {
            success: true,
            timestamp: new Date().toISOString(),
            instance: {
                name: instance.FriendlyName,
                running: instance.Running,
                state: appStateLabel(instance.AppState),
                updated
            }
        };
    } catch (error) {
        logger.error('Error during AMP status check', errorToLogMetadata(error));
        await logger.flush();
        return {
            success: false,
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
