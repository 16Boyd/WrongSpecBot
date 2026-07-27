import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SlashCommandBuilder } from 'discord.js';

interface Command {
    data: SlashCommandBuilder;
    execute: (...args: any[]) => Promise<void> | void;
}

const commands: any[] = [];

async function deployCommands(): Promise<void> {
    try {
        // Grab all the command files from the commands directory
        const commandsPath = join(__dirname, 'commands');
        const commandFiles = (await readdir(commandsPath))
            .filter(file => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts'));

        // Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
        for (const file of commandFiles) {
            const filePath = join(commandsPath, file);
            const command: Command = await import(filePath);
            
            if ('data' in command && 'execute' in command) {
                commands.push(command.data.toJSON());
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }

        const clientId = process.env.CLIENT_ID;
        const discordToken = process.env.DISCORD_TOKEN;

        if (!clientId || !discordToken) {
            throw new Error('Missing required environment variables: CLIENT_ID or DISCORD_TOKEN');
        }

        const rest = new REST({ version: '10' }).setToken(discordToken);

        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        // The put method is used to fully refresh all commands
        const data = await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        ) as any[];

        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
        console.log('Commands:', data.map(cmd => cmd.name).join(', '));
    } catch (error) {
        console.error('Error deploying commands:', error);
        process.exit(1);
    }
}

deployCommands(); 