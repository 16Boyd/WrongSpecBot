import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getAccessToken, getTokenPriceInGold } from '../lib/blizzard';

export const data = new SlashCommandBuilder()
    .setName('token')
    .setDescription('Get the current WoW Token price')
    .addStringOption(option =>
        option.setName('region')
            .setDescription('The region to check (US, EU, KR, TW)')
            .setRequired(false)
            .addChoices(
                { name: 'US', value: 'US' },
                { name: 'EU', value: 'EU' },
                { name: 'KR', value: 'KR' },
                { name: 'TW', value: 'TW' }
            ));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
        // Defer the reply since the API call might take a moment
        await interaction.deferReply();

        const region = (interaction.options.getString('region') || 'US').toUpperCase();
        const accessToken = await getAccessToken();
        const price = await getTokenPriceInGold(region, accessToken);

        await interaction.editReply(`Current WoW Token price in ${region}: ${price.toLocaleString()} gold`);
    } catch (error) {
        console.error('Error in token command:', error);
        await interaction.editReply('Sorry, I encountered an error while fetching the token price.');
    }
}
