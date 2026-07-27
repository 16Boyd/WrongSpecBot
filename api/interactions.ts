import { verifyKey } from 'discord-interactions';
import {
    APIInteraction,
    APIApplicationCommandInteraction,
    APIMessageComponentInteraction,
    APIChatInputApplicationCommandInteractionData,
    InteractionType,
    InteractionResponseType
} from 'discord-api-types/v10';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import supabase from '../src/lib/supabase';
import { getAccessToken, getTokenPriceInGold } from '../src/lib/blizzard';
import { login as ampLogin, startInstance as ampStartInstance, startApplication as ampStartApplication, ampHostname } from '../src/lib/amp';
import { editChannelMessage } from '../src/lib/discord';
import { buildAmpMessage, ampMessageSignature, DEFAULT_TEMPLATE, AMP_COLORS } from '../src/lib/ampMessage';

// Discord signs interactions over the exact raw request bytes. Disable Vercel's body
// parser so we can verify the signature against those bytes instead of a re-serialized body.
export const config = { api: { bodyParser: false } };

const EPHEMERAL = 64;

interface CommandStringOption {
    name: string;
    value: string;
}

interface CommandNumberOption {
    name: string;
    value: number;
}

async function readRawBody(req: VercelRequest): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

// Verify the request is genuinely from Discord.
function verifyDiscordRequest(req: VercelRequest, rawBody: string): boolean {
    const signature = req.headers['x-signature-ed25519'] as string | undefined;
    const timestamp = req.headers['x-signature-timestamp'] as string | undefined;
    const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim();

    if (!signature || !timestamp || !rawBody) {
        return false;
    }
    if (!publicKey || !/^[0-9a-f]{64}$/i.test(publicKey)) {
        console.error('Missing or malformed DISCORD_PUBLIC_KEY environment variable');
        return false;
    }

    try {
        return verifyKey(rawBody, signature, timestamp, publicKey);
    } catch (error) {
        console.error('Error verifying request signature:', error instanceof Error ? error.message : error);
        return false;
    }
}

// Save notification settings to Supabase (used by /notify).
async function saveNotificationSettings(settings: {
    channelId: string;
    sellThreshold: number;
    holdThreshold: number;
}): Promise<void> {
    const { error } = await supabase
        .from('notification_settings')
        .upsert({
            id: 'default',
            channel_id: settings.channelId,
            sell_threshold: settings.sellThreshold,
            hold_threshold: settings.holdThreshold,
            // Reset alert state so reconfiguring starts fresh (no stale message to edit).
            last_action: null,
            last_notified: null,
            message_id: null,
            current_price: null,
            updated_at: new Date().toISOString()
            // created_at is intentionally omitted so the DB default is preserved and not reset on update.
        }, { onConflict: 'id' });

    if (error) {
        console.error('Error saving notification settings:', error);
        throw error;
    }
}

// Edit the original (deferred) interaction response via the interaction webhook.
async function editOriginalResponse(applicationId: string, interactionToken: string, content: string): Promise<void> {
    await axios.patch(
        `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
        { content }
    );
}

// Handle /token. Discord requires a response within ~3s, so we ACK with a deferred
// response first and deliver the actual price via a follow-up webhook edit.
async function handleTokenFollowup(interaction: APIApplicationCommandInteraction): Promise<void> {
    const commandData = interaction.data as APIChatInputApplicationCommandInteractionData;
    const regionOption = commandData.options?.[0] as CommandStringOption | undefined;
    const region = (regionOption?.value || 'US').toUpperCase();

    try {
        const accessToken = await getAccessToken();
        const price = await getTokenPriceInGold(region, accessToken);
        await editOriginalResponse(
            interaction.application_id,
            interaction.token,
            `Current WoW Token price in ${region}: ${price.toLocaleString()} gold`
        );
    } catch (error) {
        console.error('Error in token command:', error instanceof Error ? error.message : error);
        await editOriginalResponse(
            interaction.application_id,
            interaction.token,
            'Sorry, I encountered an error while fetching the token price.'
        );
    }
}

// Handle /notify. Fast single DB write, so we respond synchronously.
async function handleNotify(interaction: APIApplicationCommandInteraction) {
    const commandData = interaction.data as APIChatInputApplicationCommandInteractionData;

    // Authorize by immutable Discord user ID (usernames are mutable and not unique).
    const authorizedUsers = process.env.AUTHORIZED_USERS?.split(',').map(u => u.trim()).filter(Boolean) || [];
    const userId = interaction.member?.user?.id || interaction.user?.id;

    if (!userId || !authorizedUsers.includes(userId)) {
        // Do not disclose the authorized-user list to unauthorized callers.
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'You are not authorized to use this command.', flags: EPHEMERAL }
        };
    }

    const options = commandData.options || [];
    const sellThresholdOption = options.find(o => o.name === 'sell_threshold') as CommandNumberOption | undefined;
    const holdThresholdOption = options.find(o => o.name === 'hold_threshold') as CommandNumberOption | undefined;
    const channelOption = options.find(o => o.name === 'channel') as CommandStringOption | undefined;

    if (!sellThresholdOption || !holdThresholdOption || !channelOption) {
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Missing required options.', flags: EPHEMERAL }
        };
    }

    const sellThreshold = sellThresholdOption.value;
    const holdThreshold = holdThresholdOption.value;
    const channel = channelOption.value;

    if (sellThreshold <= holdThreshold) {
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Sell threshold must be higher than hold threshold.', flags: EPHEMERAL }
        };
    }

    try {
        await saveNotificationSettings({ channelId: channel, sellThreshold, holdThreshold });
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: `Notifications set up successfully!\nSell threshold: ${sellThreshold.toLocaleString()} gold\nHold threshold: ${holdThreshold.toLocaleString()} gold\nNotifications will be sent to <#${channel}>`,
                flags: EPHEMERAL
            }
        };
    } catch (error) {
        console.error('Error in notify command:', error instanceof Error ? error.message : error);
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Sorry, I encountered an error while setting up notifications.', flags: EPHEMERAL }
        };
    }
}

// Handle the "Start Server" button on an AMP status message. The custom_id carries the target
// instance ID (`amp_start:<instanceId>`).
//
// The AMP start chain (controller login + StartInstance + instance login + Core/Start) commonly
// exceeds Discord's ~3s interaction window, so handleAmpStart defers the response first, then runs
// the work and edits the reply — see the detailed note there.
//
// The button is intentionally open to anyone in the channel: the instance auto-stops when empty,
// so letting players start it themselves is the point.
// Auto-dismiss the ephemeral start confirmation after a few minutes (done by the amp-status cron).
const EPHEMERAL_CLEANUP_MS = 3 * 60 * 1000;

// Update the public status message to show "Start Requested" until the next scheduled check
// refreshes it with the real state. Best-effort — failure here shouldn't fail the start.
async function markStartRequested(instanceId: string): Promise<void> {
    try {
        const { data, error } = await supabase
            .from('amp_instance_status')
            .select('*')
            .eq('instance_id', instanceId)
            .single();
        if (error || !data?.channel_id || !data?.message_id) {
            return;
        }

        const message = buildAmpMessage({
            title: data.title || 'Server Status',
            template: data.description_template || DEFAULT_TEMPLATE,
            status: 'Start Requested',
            userCount: 0,
            maxUsers: 0,
            state: 'Start Requested',
            domain: ampHostname(),
            port: data.port != null ? String(data.port) : '',
            color: AMP_COLORS.pending,
            startButtonInstanceId: null // hide the button while a start is pending
        });

        await editChannelMessage(data.channel_id, data.message_id, message);
        // Store this as last_status so the cron sees a change next tick and re-renders the real
        // state. start_requested_at opens the grace window: while it's recent and the app is still
        // offline, the cron keeps this "Start Requested" message instead of reverting to Offline.
        const now = new Date().toISOString();
        await supabase
            .from('amp_instance_status')
            .update({ last_status: ampMessageSignature(message), start_requested_at: now, updated_at: now })
            .eq('instance_id', instanceId);
    } catch (error) {
        console.error('Failed to mark start requested:', error instanceof Error ? error.message : error);
    }
}

// Record an ephemeral confirmation for later deletion by the amp-status cron (serverless can't
// wait minutes itself). The cron deletes any rows whose delete_at has passed.
async function scheduleEphemeralCleanup(applicationId: string, interactionToken: string): Promise<void> {
    try {
        const { error } = await supabase.from('ephemeral_message_cleanup').insert({
            application_id: applicationId,
            interaction_token: interactionToken,
            delete_at: new Date(Date.now() + EPHEMERAL_CLEANUP_MS).toISOString()
        });
        if (error) {
            console.error('Failed to schedule ephemeral cleanup:', error);
        }
    } catch (error) {
        console.error('Failed to schedule ephemeral cleanup:', error instanceof Error ? error.message : error);
    }
}

async function handleAmpStart(interaction: APIMessageComponentInteraction, res: VercelResponse): Promise<void> {
    // Acknowledge the click IMMEDIATELY with a deferred (ephemeral) response. The AMP work below —
    // a controller login, StartInstance, a second instance-scoped login, and Core/Start — regularly
    // takes longer than Discord's ~3s interaction window, which is what produced the "Did not
    // respond in time" errors. Deferring ACKs in milliseconds; we then do the work and edit this
    // reply with the outcome. The serverless function stays alive until this handler's promise
    // resolves, so the awaited work still runs (the same pattern /token uses successfully here).
    res.status(200).json({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: EPHEMERAL }
    });

    const instanceId = interaction.data.custom_id.split(':')[1];

    let content: string;
    if (!instanceId) {
        content = 'Could not determine which server to start.';
    } else {
        try {
            const sessionId = await ampLogin();
            // Ensure the instance daemon is up, then start the game application inside it. For an
            // already-running daemon (the common case) StartInstance is a no-op and Core/Start does
            // the real work of booting the game server.
            await ampStartInstance(sessionId, instanceId);
            await ampStartApplication(sessionId, instanceId);
            // Reflect the pending start on the public status message until the next cron check.
            await markStartRequested(instanceId);
            content = '▶️ Start requested — the server is booting up. The status message will update shortly.';
        } catch (error) {
            console.error('Error starting AMP instance:', error instanceof Error ? error.message : error);
            content = 'Sorry, I could not start the server. Please try again or check the AMP panel.';
        }
    }

    // Deliver the outcome by editing the deferred reply, then schedule its auto-dismiss.
    try {
        await editOriginalResponse(interaction.application_id, interaction.token, content);
    } catch (error) {
        console.error('Failed to edit deferred start response:', error instanceof Error ? error.message : error);
    }
    await scheduleEphemeralCleanup(interaction.application_id, interaction.token);
}

// Export the handler for Vercel
export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const rawBody = await readRawBody(req);

    if (!verifyDiscordRequest(req, rawBody)) {
        res.status(401).json({ error: 'Invalid request signature' });
        return;
    }

    let interaction: APIInteraction;
    try {
        interaction = JSON.parse(rawBody) as APIInteraction;
    } catch {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
    }

    if (interaction.type === InteractionType.Ping) {
        res.status(200).json({ type: InteractionResponseType.Pong });
        return;
    }

    if (interaction.type === InteractionType.MessageComponent) {
        const customId = interaction.data.custom_id;

        if (customId.startsWith('amp_start:')) {
            // Defers immediately, then runs the AMP start and edits the reply (see handleAmpStart).
            await handleAmpStart(interaction, res);
            return;
        }

        res.status(200).json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Unknown interaction', flags: EPHEMERAL }
        });
        return;
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
        const commandData = interaction.data as APIChatInputApplicationCommandInteractionData;

        if (commandData.name === 'token') {
            // ACK immediately, then continue running to deliver the follow-up. On Vercel the
            // function stays alive until this handler's promise resolves, so the await below runs.
            res.status(200).json({
                type: InteractionResponseType.DeferredChannelMessageWithSource,
                data: { flags: EPHEMERAL }
            });
            await handleTokenFollowup(interaction);
            return;
        }

        if (commandData.name === 'notify') {
            const response = await handleNotify(interaction);
            res.status(200).json(response);
            return;
        }

        res.status(200).json({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: { content: 'Unknown command', flags: EPHEMERAL }
        });
        return;
    }

    res.status(200).json({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: 'Unknown interaction type', flags: EPHEMERAL }
    });
}
