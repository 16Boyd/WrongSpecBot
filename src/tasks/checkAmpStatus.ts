import supabase from '../lib/supabase';
import Logger from '../lib/logger';
import { login, getAllInstances, getPlayerCount, appStateLabel, AmpInstance } from '../lib/amp';
import { sendChannelMessage, editChannelMessage, deleteInteractionResponse, MessageBody } from '../lib/discord';
import { buildAmpMessage, ampMessageSignature, DEFAULT_TEMPLATE, AMP_COLORS } from '../lib/ampMessage';

function errorToLogMetadata(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }
    return { error: String(error) };
}

// One row per watched AMP instance. instance_id is the primary key.
interface AmpStatusSettings {
    instance_id: string;
    channel_id: string | null;
    message_id: string | null;
    last_status: string | null;
    title: string | null;
    description_template: string | null;
}

interface InstanceSummary {
    instanceId: string;
    name?: string;
    running?: boolean;
    state?: string;
    updated?: boolean;
    error?: string;
}

export interface CheckAmpStatusResult {
    success: boolean;
    timestamp: string;
    instances?: InstanceSummary[];
    // Every instance AMP reports (regardless of configuration) — a setup aid for finding InstanceIDs.
    availableInstances?: Array<{ instanceId: string; name: string; module: string; running: boolean; state: string }>;
    error?: string;
}

// AMP AppState for a fully running/ready application. NOTE: we key on AppState, not the
// instance's `Running` flag — for GenericModule instances AMP reports Running:true even when
// the game server's AppState is 0 (Stopped), so `Running` is not a reliable up/down signal.
const READY_STATE = 20;

// AppStates where the instance is mid-transition; we hide the Start button so a user
// can't fire a redundant start while one is already in flight.
const TRANSITIONAL_STATES = [5, 7, 10, 30, 40, 70, 75];

// Load every configured instance (one row each). Rows missing a channel are skipped upstream.
async function getAllSettings(logger: Logger): Promise<AmpStatusSettings[]> {
    const { data, error } = await supabase
        .from('amp_instance_status')
        .select('*');

    if (error) {
        logger.error('Failed to get AMP status settings', errorToLogMetadata(error));
        return [];
    }
    return data ?? [];
}

async function updateSettings(instanceId: string, fields: Partial<AmpStatusSettings>, logger: Logger): Promise<void> {
    const { error } = await supabase
        .from('amp_instance_status')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('instance_id', instanceId);

    if (error) {
        logger.error('Failed to update AMP status settings', errorToLogMetadata(error));
    }
}

// A human-readable status word for the {status} placeholder, based purely on the app's state
// (not player count): Ready -> Online, a transitional state -> its label, anything else
// (Stopped/Failed/…) -> Offline.
function statusWord(instance: AmpInstance): string {
    if (instance.AppState === READY_STATE) return 'Online';
    if (TRANSITIONAL_STATES.includes(instance.AppState)) return appStateLabel(instance.AppState);
    return 'Offline';
}

function buildMessage(instance: AmpInstance, settings: AmpStatusSettings): MessageBody {
    const isReady = instance.AppState === READY_STATE;
    const isTransitioning = TRANSITIONAL_STATES.includes(instance.AppState);
    // Show the Start button whenever the app is stopped/failed/etc. — anything that isn't Ready
    // and isn't already mid-transition.
    const showStart = !isReady && !isTransitioning;
    const players = getPlayerCount(instance);

    return buildAmpMessage({
        title: settings.title || instance.FriendlyName || instance.Module || 'Server Status',
        template: settings.description_template || DEFAULT_TEMPLATE,
        status: statusWord(instance),
        userCount: players?.online ?? 0,
        maxUsers: players?.max ?? 0,
        state: appStateLabel(instance.AppState),
        // Green online, yellow transitioning, red offline.
        color: isReady ? AMP_COLORS.online : isTransitioning ? AMP_COLORS.pending : AMP_COLORS.offline,
        startButtonInstanceId: showStart ? instance.InstanceID : null
    });
}

// Delete any ephemeral "Start requested" confirmation messages whose scheduled time has passed.
// The button handler records these (interaction token + delete_at); serverless can't wait minutes
// itself, so this every-minute task performs the deletion.
async function processEphemeralCleanups(logger: Logger): Promise<void> {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from('ephemeral_message_cleanup')
        .select('*')
        .lte('delete_at', nowIso);

    if (error) {
        logger.error('Failed to load ephemeral cleanups', errorToLogMetadata(error));
        return;
    }
    if (!data || data.length === 0) {
        return;
    }

    for (const row of data) {
        try {
            await deleteInteractionResponse(row.application_id, row.interaction_token);
        } catch (error) {
            // Token expired or message already gone — log and still remove the record.
            logger.warn(`Could not delete ephemeral message (cleanup ${row.id})`, errorToLogMetadata(error));
        }
        await supabase.from('ephemeral_message_cleanup').delete().eq('id', row.id);
    }
    logger.info(`Processed ${data.length} ephemeral message cleanup(s)`);
}

// Post or update the Discord status message for a single configured instance.
async function processInstance(
    settings: AmpStatusSettings,
    instance: AmpInstance | undefined,
    logger: Logger
): Promise<InstanceSummary> {
    if (!settings.channel_id) {
        logger.info(`Instance ${settings.instance_id} has no channel configured, skipping`);
        return { instanceId: settings.instance_id, error: 'no channel configured' };
    }

    if (!instance) {
        logger.warn(`AMP instance ${settings.instance_id} not found in GetInstances output (check the GUID)`);
        return { instanceId: settings.instance_id, error: 'instance not found' };
    }

    logger.info(`Matched instance ${settings.instance_id}`, {
        friendlyName: instance.FriendlyName,
        running: instance.Running,
        appState: instance.AppState,
        playerMetricPresent: !!instance.Metrics?.['Active Users'],
        metricKeys: Object.keys(instance.Metrics ?? {})
    });

    const message = buildMessage(instance, settings);
    const signature = ampMessageSignature(message);

    // Log the exact data going into the message so the rendered output is fully visible.
    const players = getPlayerCount(instance);
    const embed = (message.embeds?.[0] ?? {}) as { title?: string; description?: string; color?: number };
    logger.info(`Prepared message for ${instance.FriendlyName}`, {
        title: embed.title,
        status: statusWord(instance),
        userCount: players?.online ?? 0,
        maxUsers: players?.max ?? 0,
        rawActiveUsers: instance.Metrics?.['Active Users'],
        endpoints: instance.ApplicationEndpoints,
        color: embed.color,
        showStartButton: (message.components?.length ?? 0) > 0,
        templateSource: settings.description_template ? 'db' : 'default',
        description: embed.description,
        hasExistingMessage: !!settings.message_id,
        signatureChanged: signature !== settings.last_status
    });

    let updated = false;

    if (!settings.message_id) {
        // No live message yet: post a fresh one.
        const messageId = await sendChannelMessage(settings.channel_id, message);
        await updateSettings(settings.instance_id, { message_id: messageId, last_status: signature }, logger);
        updated = true;
        logger.info(`Posted new AMP status message for ${instance.FriendlyName}: ${messageId}`);
    } else if (signature !== settings.last_status) {
        // Something visible changed: edit in place so the message stays put in the channel.
        try {
            await editChannelMessage(settings.channel_id, settings.message_id, message);
            await updateSettings(settings.instance_id, { last_status: signature }, logger);
            updated = true;
            logger.info(`Edited AMP status message for ${instance.FriendlyName}: ${settings.message_id}`);
        } catch (error) {
            // The message was likely deleted; drop the reference so the next tick reposts it.
            logger.warn('Could not edit AMP status message - clearing stale message ID', errorToLogMetadata(error));
            await updateSettings(settings.instance_id, { message_id: null }, logger);
        }
    } else {
        logger.info(`AMP status for ${instance.FriendlyName} unchanged since last check, no update needed`);
    }

    return {
        instanceId: settings.instance_id,
        name: instance.FriendlyName,
        running: instance.AppState === READY_STATE,
        state: appStateLabel(instance.AppState),
        updated
    };
}

export async function checkAmpStatus(): Promise<CheckAmpStatusResult> {
    const logger = new Logger('check-amp-status');

    try {
        logger.info('Starting AMP instance status check...');

        // Delete any due "Start requested" ephemeral confirmations (independent of AMP config).
        await processEphemeralCleanups(logger);

        // If AMP isn't configured at all, the feature is off — skip without calling AMP.
        if (!process.env.AMP_URL) {
            logger.info('AMP_URL not set, skipping AMP status check');
            await logger.flush();
            return { success: true, timestamp: new Date().toISOString() };
        }

        const rows = (await getAllSettings(logger)).filter(row => row.instance_id && row.channel_id);
        logger.info(`Found ${rows.length} configured AMP instance row(s)`, {
            instanceIds: rows.map(r => r.instance_id)
        });

        // One login + one GetInstances covers every configured row. getAllInstances() logs the
        // full list, so InstanceIDs can be discovered here even before any row is configured.
        const sessionId = await login();
        const allInstances = await getAllInstances(sessionId);

        // Always surface the discovered instances (handy during setup).
        const availableInstances = allInstances.map(i => ({
            instanceId: i.InstanceID,
            name: i.FriendlyName,
            module: i.Module,
            running: i.AppState === READY_STATE,
            state: appStateLabel(i.AppState)
        }));

        if (rows.length === 0) {
            logger.info('No AMP instance rows configured yet — copy an InstanceID from the list above into the amp_instance_status table to activate a status message');
            await logger.flush();
            return { success: true, timestamp: new Date().toISOString(), availableInstances };
        }

        const byId = new Map(allInstances.map(inst => [inst.InstanceID, inst]));

        const summaries: InstanceSummary[] = [];
        for (const row of rows) {
            try {
                summaries.push(await processInstance(row, byId.get(row.instance_id), logger));
            } catch (error) {
                // Isolate per-instance failures so one bad row doesn't sink the rest.
                logger.error(`Error processing instance ${row.instance_id}`, errorToLogMetadata(error));
                summaries.push({
                    instanceId: row.instance_id,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        await logger.flush();
        return { success: true, timestamp: new Date().toISOString(), instances: summaries, availableInstances };
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
