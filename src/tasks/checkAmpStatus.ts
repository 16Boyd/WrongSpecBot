import supabase from '../lib/supabase';
import Logger, { errorToLogMetadata } from '../lib/logger';
import { login, getAllInstances, getPlayerCount, appStateLabel, ampHostname, startServer, AmpInstance } from '../lib/amp';
import { sendChannelMessage, editChannelMessage, deleteInteractionResponse, MessageBody } from '../lib/discord';
import { buildAmpMessage, ampMessageSignature, DEFAULT_TEMPLATE, AMP_COLORS } from '../lib/ampMessage';

// One row per watched AMP instance. instance_id is the primary key.
interface AmpStatusSettings {
    instance_id: string;
    channel_id: string | null;
    message_id: string | null;
    last_status: string | null;
    title: string | null;
    description_template: string | null;
    // Port to show for {port}. Author-set per row, since games expose multiple ports and AMP
    // doesn't tell us which one to display.
    port: number | null;
    // ISO timestamp set when a user pressed Start Server. While this is recent (see
    // START_REQUEST_GRACE_MS) and the app is still offline, the cron leaves the "Start Requested"
    // message in place instead of flipping it back to Offline mid-boot.
    start_requested_at: string | null;
    // True from the moment Start Server is pressed until a start has actually been performed. The
    // button attempts the start immediately in the background; if the serverless runtime froze that
    // attempt, this flag tells the cron to perform the start itself (guaranteed fallback).
    start_pending: boolean | null;
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

// Grace period after a user presses Start Server. A game server can take a while to leave the
// Stopped state, and the cron runs every minute, so the first tick after a click often still sees
// the app Offline. Within this window we keep the "Start Requested" message rather than flipping it
// back to Offline, which would look like the start failed.
const START_REQUEST_GRACE_MS = 2 * 60 * 1000;

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
        domain: ampHostname(),
        port: settings.port != null ? String(settings.port) : '',
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
            // Transient failure (rate limit, network blip, etc.) — leave the row for retry next
            // tick instead of losing it. Discord interaction tokens expire after 15 minutes, so a
            // permanently-gone message just stops mattering rather than retrying forever.
            logger.warn(`Could not delete ephemeral message (cleanup ${row.id})`, errorToLogMetadata(error));
            continue;
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

    // Offline = not ready and not mid-transition (Stopped/Failed/etc.).
    const isOffline = instance.AppState !== READY_STATE && !TRANSITIONAL_STATES.includes(instance.AppState);

    // Fallback start: a user pressed Start Server (start_pending) but the server is still offline —
    // typically because the button's background start attempt was frozen by the serverless runtime.
    // Perform the start here so it always happens even if that attempt never ran. Idempotent: if the
    // start already succeeded the app wouldn't be offline, and re-starting an already-running server
    // is a no-op in AMP.
    let startRequestedAt = settings.start_requested_at;
    if (settings.start_pending) {
        if (isOffline) {
            try {
                logger.info(`start_pending set and ${instance.FriendlyName} still offline — performing fallback start`);
                await startServer(settings.instance_id);
                // Re-open the grace window from now so the message stays "Start Requested" while the
                // freshly-kicked server boots, and clear the pending flag.
                const now = new Date().toISOString();
                await updateSettings(settings.instance_id, { start_pending: false, start_requested_at: now }, logger);
                startRequestedAt = now;
            } catch (error) {
                // Clear the flag so we don't hammer AMP every minute; the user can press Start again.
                logger.error(`Fallback start failed for ${settings.instance_id}`, errorToLogMetadata(error));
                await updateSettings(settings.instance_id, { start_pending: false }, logger);
            }
        } else {
            // Server already came up (or is transitioning) — the start took effect; just clear the flag.
            await updateSettings(settings.instance_id, { start_pending: false }, logger);
        }
    }

    // If a start was requested recently and the server is still offline (hasn't begun booting
    // yet), leave the "Start Requested" message untouched until the grace window elapses.
    if (isOffline && startRequestedAt) {
        // Clamp negative values: start_requested_at was written by a different serverless
        // invocation, so a slightly-ahead writer clock shouldn't silently disable the grace window.
        const elapsedMs = Math.max(0, Date.now() - Date.parse(startRequestedAt));
        if (Number.isFinite(elapsedMs) && elapsedMs < START_REQUEST_GRACE_MS) {
            logger.info(
                `Start requested ${Math.round(elapsedMs / 1000)}s ago for ${instance.FriendlyName} and still offline ` +
                `— keeping "Start Requested" message (grace ${START_REQUEST_GRACE_MS / 1000}s)`
            );
            return {
                instanceId: settings.instance_id,
                name: instance.FriendlyName,
                running: false,
                state: appStateLabel(instance.AppState),
                updated: false
            };
        }
    }

    const message = buildMessage(instance, settings);
    const signature = ampMessageSignature(message);

    // Log the exact data going into the message so the rendered output is fully visible.
    const players = getPlayerCount(instance);
    const embed = (message.embeds?.[0] ?? {}) as {
        title?: string;
        description?: string;
        color?: number;
        fields?: Array<{ value: string }>;
    };
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
        layout: embed.fields ? `${embed.fields.length} column(s)` : 'single',
        // With columns the body lives in fields; otherwise in description.
        body: embed.description ?? embed.fields?.map(f => f.value).join('\n---\n'),
        hasExistingMessage: !!settings.message_id,
        signatureChanged: signature !== settings.last_status
    });

    let updated = false;

    if (!settings.message_id) {
        // No live message yet: post a fresh one.
        const messageId = await sendChannelMessage(settings.channel_id, message);
        await updateSettings(settings.instance_id, { message_id: messageId, last_status: signature, start_requested_at: null, start_pending: false }, logger);
        updated = true;
        logger.info(`Posted new AMP status message for ${instance.FriendlyName}: ${messageId}`);
    } else if (signature !== settings.last_status) {
        // Something visible changed: edit in place so the message stays put in the channel.
        // Clearing start_requested_at retires the grace window now that we're showing real state.
        try {
            await editChannelMessage(settings.channel_id, settings.message_id, message);
            await updateSettings(settings.instance_id, { last_status: signature, start_requested_at: null, start_pending: false }, logger);
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
