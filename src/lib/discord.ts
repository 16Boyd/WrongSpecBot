import { REST, Routes } from 'discord.js';
import axios from 'axios';

// Lightweight REST client for one-shot message operations.
// Using REST avoids opening a gateway (WebSocket) connection and logging in just to
// send/edit/delete a single message, which is slow and subject to identify rate limits.
function rest(): REST {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        throw new Error('Missing DISCORD_TOKEN environment variable');
    }
    return new REST({ version: '10' }).setToken(token);
}

export interface MessageBody {
    content?: string;
    embeds?: unknown[];
    // Raw Discord message components (action rows / buttons). Pass [] to clear existing components.
    components?: unknown[];
}

// Send a message to a channel and return the new message ID.
export async function sendChannelMessage(channelId: string, body: MessageBody): Promise<string> {
    const result = await rest().post(Routes.channelMessages(channelId), { body }) as { id: string };
    return result.id;
}

// Edit an existing message.
export async function editChannelMessage(channelId: string, messageId: string, body: MessageBody): Promise<void> {
    await rest().patch(Routes.channelMessage(channelId, messageId), { body });
}

// Delete an existing message.
export async function deleteChannelMessage(channelId: string, messageId: string): Promise<void> {
    await rest().delete(Routes.channelMessage(channelId, messageId));
}

// Delete an interaction's original (ephemeral) response. The interaction token itself authorises
// the request (no bot token needed); tokens are valid for ~15 minutes after the interaction.
export async function deleteInteractionResponse(applicationId: string, interactionToken: string): Promise<void> {
    await axios.delete(
        `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`
    );
}
