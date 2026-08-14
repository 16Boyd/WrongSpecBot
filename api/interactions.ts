import { verifyKey } from 'discord-interactions';
import { 
    APIInteraction, 
    APIInteractionResponse,
    InteractionType,
    InteractionResponseType,
    APIApplicationCommandInteractionData,
    APIChatInputApplicationCommandInteractionData,
    APIApplicationCommandInteractionDataOption,
    ApplicationCommandOptionType
} from 'discord-api-types/v10';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAccessToken, getTokenPrice } from '../src/lib/blizzard';
import { saveNotificationSettingsRow } from '../src/lib/notificationSettings';

interface NotificationSettings {
    channelId: string;
    sellThreshold: number;
    holdThreshold: number;
    lastAction: string | null;
    lastNotified: string | null;
}

// Save notification settings to Supabase
async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
    console.log('Saving notification settings:', JSON.stringify(settings, null, 2));

    const now = new Date().toISOString();

    const success = await saveNotificationSettingsRow({
        channel_id: settings.channelId,
        sell_threshold: settings.sellThreshold,
        hold_threshold: settings.holdThreshold,
        last_action: settings.lastAction || null,
        last_notified: settings.lastNotified ? new Date(settings.lastNotified).toISOString() : null,
        created_at: now,
        updated_at: now
    });

    if (!success) {
        throw new Error('Failed to save notification settings');
    }

    console.log('Notification settings saved successfully');
}

interface VercelRequestWithRawBody extends VercelRequest {
    rawBody?: string;
}

interface CommandNumberOption {
    name: string;
    type: ApplicationCommandOptionType.Number;
    value: number;
}

interface CommandStringOption {
    name: string;
    type: ApplicationCommandOptionType.String;
    value: string;
}

// Verify the request is from Discord
function verifyDiscordRequest(request: VercelRequestWithRawBody): void {
    const signature = request.headers['x-signature-ed25519'] as string;
    const timestamp = request.headers['x-signature-timestamp'] as string;
    const rawBody = request.rawBody || JSON.stringify(request.body);
    
    // Debug logging
    console.log('Request headers:', {
        'x-signature-ed25519': signature,
        'x-signature-timestamp': timestamp
    });
    console.log('Raw body:', rawBody);
    console.log('Public key:', process.env.DISCORD_PUBLIC_KEY);
    
    // Check if we have the required headers and public key
    if (!signature || !timestamp || !rawBody) {
        console.error('Missing required headers:', { signature, timestamp, rawBody });
        throw new Error('Missing required headers');
    }

    if (!process.env.DISCORD_PUBLIC_KEY) {
        console.error('Missing DISCORD_PUBLIC_KEY environment variable');
        throw new Error('Server configuration error');
    }

    // Ensure the public key is a valid hex string
    const publicKey = process.env.DISCORD_PUBLIC_KEY.trim();
    if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
        console.error('Invalid public key format:', publicKey);
        throw new Error('Invalid public key format');
    }

    try {
        const isValidRequest = verifyKey(
            rawBody,
            signature,
            timestamp,
            publicKey
        );
        
        if (!isValidRequest) {
            console.error('Invalid request signature');
            throw new Error('Invalid request signature');
        }
    } catch (error) {
        console.error('Error verifying request:', error);
        throw new Error('Failed to verify request');
    }
}

// Handle the interaction
async function handleInteraction(interaction: APIInteraction): Promise<APIInteractionResponse> {
    if (interaction.type === InteractionType.Ping) {
        return { type: InteractionResponseType.Pong };
    }

    if (interaction.type === InteractionType.ApplicationCommand) {
        const commandData = interaction.data as APIChatInputApplicationCommandInteractionData;
        
        // Handle token command
        if (commandData.name === 'token') {
            try {
                // Get region from options or default to US
                const regionOption = commandData.options?.[0] as CommandStringOption | undefined;
                const region = regionOption?.value || 'US';
                
                // Get token price
                const accessToken = await getAccessToken();
                const price = await getTokenPrice(region, accessToken);
                
                return {
                    type: InteractionResponseType.ChannelMessageWithSource,
                    data: {
                        content: `Current WoW Token price in ${region}: ${price.toLocaleString()} gold`,
                        flags: 64 // Ephemeral flag
                    }
                };
            } catch (error) {
                console.error('Error in token command:', error);
                return {
                    type: InteractionResponseType.ChannelMessageWithSource,
                    data: {
                        content: 'Sorry, I encountered an error while fetching the token price.',
                        flags: 64 // Ephemeral flag
                    }
                };
            }
        }
        // Handle notify command
        else if (commandData.name === 'notify') {
            try {
                // Check if user is authorized (comma-separated list in environment variable)
                const authorizedUsers = process.env.AUTHORIZED_USERS?.split(',').map(u => u.trim()) || [];
                
                const username = interaction.member?.user?.username || interaction.user?.username;
                
                if (!authorizedUsers.includes(username || '')) {
                    return {
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: {
                            content: `You are not authorized to use this command. Authorized users: ${authorizedUsers.join(', ')}`,
                            flags: 64 // Ephemeral flag
                        }
                    };
                }

                const options = commandData.options || [];
                const sellThresholdOption = options.find(opt => opt.name === 'sell_threshold') as CommandNumberOption;
                const holdThresholdOption = options.find(opt => opt.name === 'hold_threshold') as CommandNumberOption;
                const channelOption = options.find(opt => opt.name === 'channel') as CommandStringOption;

                if (!sellThresholdOption || !holdThresholdOption || !channelOption) {
                    return {
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: {
                            content: 'Missing required options.',
                            flags: 64 // Ephemeral flag
                        }
                    };
                }

                const sellThreshold = sellThresholdOption.value;
                const holdThreshold = holdThresholdOption.value;
                const channel = channelOption.value;

                // Validate thresholds
                if (sellThreshold <= holdThreshold) {
                    return {
                        type: InteractionResponseType.ChannelMessageWithSource,
                        data: {
                            content: 'Sell threshold must be higher than hold threshold.',
                            flags: 64 // Ephemeral flag
                        }
                    };
                }
                
                const settingsToSave: NotificationSettings = {
                    sellThreshold,
                    holdThreshold,
                    channelId: channel,
                    lastNotified: null,
                    lastAction: null
                };
                
                // Save notification settings
                await saveNotificationSettings(settingsToSave);

                return {
                    type: InteractionResponseType.ChannelMessageWithSource,
                    data: {
                        content: `Notifications set up successfully!\nSell threshold: ${sellThreshold.toLocaleString()} gold\nHold threshold: ${holdThreshold.toLocaleString()} gold\nNotifications will be sent to <#${channel}>`,
                        flags: 64 // Ephemeral flag
                    }
                };
            } catch (error) {
                console.error('Error in notify command:', error);
                
                return {
                    type: InteractionResponseType.ChannelMessageWithSource,
                    data: {
                        content: 'Sorry, I encountered an error while setting up notifications.',
                        flags: 64 // Ephemeral flag
                    }
                };
            }
        }

        // Unknown command
        return {
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
                content: 'Unknown command',
                flags: 64 // Ephemeral flag
            }
        };
    }

    // Unknown interaction type
    return {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: {
            content: 'Unknown interaction type',
            flags: 64 // Ephemeral flag
        }
    };
}

// Export the handler for Vercel
export default async function handler(
    req: VercelRequestWithRawBody,
    res: VercelResponse
): Promise<VercelResponse> {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Verify the request is from Discord
        verifyDiscordRequest(req);

        // Handle the interaction
        const response = await handleInteraction(req.body);
        return res.status(200).json(response);
    } catch (error) {
        console.error('Error handling interaction:', error);
        return res.status(400).json({ 
            error: error instanceof Error ? error.message : 'Unknown error',
            details: process.env.NODE_ENV === 'development' && error instanceof Error ? error.stack : undefined
        });
    }
} 