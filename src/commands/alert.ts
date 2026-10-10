import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Manage your private WoW Token price alerts')
    .addSubcommand(subcommand => subcommand
        .setName('set')
        .setDescription('Create a durable personal price alert')
        .addStringOption(option => option
            .setName('direction')
            .setDescription('Alert when the price rises above or falls below the target')
            .setRequired(true)
            .addChoices({ name: 'At or above', value: 'above' }, { name: 'At or below', value: 'below' }))
        .addIntegerOption(option => option
            .setName('price')
            .setDescription('Target price in gold')
            .setRequired(true)
            .setMinValue(1))
        .addStringOption(option => option
            .setName('region')
            .setDescription('WoW region (defaults to the bot watch region)')
            .setRequired(false)
            .addChoices({ name: 'US', value: 'US' }, { name: 'EU', value: 'EU' }, { name: 'KR', value: 'KR' }, { name: 'TW', value: 'TW' }))
        .addIntegerOption(option => option
            .setName('reset_gap')
            .setDescription('Percent the price must move away before this alert rearms (default 3%)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10)))
    .addSubcommand(subcommand => subcommand
        .setName('list')
        .setDescription('List your personal price alerts'))
    .addSubcommand(subcommand => subcommand
        .setName('remove')
        .setDescription('Remove one of your personal price alerts')
        .addStringOption(option => option
            .setName('alert_id')
            .setDescription('Alert ID shown by /alert list')
            .setRequired(true)));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({ content: 'This command is handled by the serverless function.', ephemeral: true });
}
