import { SlashCommandBuilder, ChatInputCommandInteraction, ChannelType } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Set up the rolling WoW Token price status message')
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('Channel to send notifications to')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // The actual /notify logic runs in the serverless handler (api/interactions.ts).
    // This gateway-mode stub only exists so the command registers with a description.
    await interaction.reply({
        content: 'This command is handled by the serverless function.',
        ephemeral: true
    });
}
