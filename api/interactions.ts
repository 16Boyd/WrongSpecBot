import { verifyKey } from 'discord-interactions';
import {
    APIInteraction,
    APIApplicationCommandInteraction,
    APIChatInputApplicationCommandInteractionData,
    InteractionType,
    InteractionResponseType
} from 'discord-api-types/v10';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import supabase from '../src/lib/supabase';
import { getAccessToken, getTokenPriceInGold } from '../src/lib/blizzard';

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
