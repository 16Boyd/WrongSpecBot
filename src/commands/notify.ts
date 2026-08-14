import { SlashCommandBuilder, ChatInputCommandInteraction, ChannelType } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Set up guild-wide token price notifications')
    .addIntegerOption(option =>
        option.setName('sell_threshold')
            .setDescription('Price threshold to notify when token price is high enough to sell')
            .setRequired(true)
            .setMinValue(1))
    .addIntegerOption(option =>
        option.setName('hold_threshold')
            .setDescription('Price threshold to notify when token price is low enough to buy')
            .setRequired(true)
            .setMinValue(1))
    .addChannelOption(option =>
        option.setName('channel')
            .setDescription('Channel to send notifications to')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // This function is not used in serverless deployment
    // The actual logic is handled in api/interactions.js
    await interaction.reply({
        content: 'This command is handled by the serverless function.',
        ephemeral: true
    });
} 