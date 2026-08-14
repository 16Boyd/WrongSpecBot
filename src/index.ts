import 'dotenv/config';
import { 
    Client, 
    Collection, 
    GatewayIntentBits, 
    Events, 
    ChatInputCommandInteraction,
    SlashCommandBuilder
} from 'discord.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Define the command interface
interface Command {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Extend the Client interface to include commands collection
declare module 'discord.js' {
    export interface Client {
        commands: Collection<string, Command>;
    }
}

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.DirectMessages
    ]
});

// Create a new commands collection
client.commands = new Collection<string, Command>();

// Load commands
async function loadCommands(): Promise<void> {
    const commandsPath = join(__dirname, 'commands');
    const commandFiles = (await readdir(commandsPath))
        .filter(file => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts'));

    for (const file of commandFiles) {
        const filePath = join(commandsPath, file);
        // Commands use named exports (`data`, `execute`), not a default export.
        const command = await import(filePath) as Command;

        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

// When the client is ready, run this code (only once)
client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    console.log(`Bot is in ${client.guilds.cache.size} servers`);
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
        } else {
            await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
    }
});

// Add error handling
client.on('error', (error: Error) => {
    console.error('Discord client error:', error);
});

// Handle disconnects
client.on('disconnect', () => {
    console.log('Bot disconnected from Discord');
});

// Handle reconnecting
client.on('reconnecting', () => {
    console.log('Bot is reconnecting to Discord...');
});

// Handle rate limits
client.on('rateLimit', (rateLimitInfo: any) => {
    console.log('Rate limit hit:', rateLimitInfo);
});

// Handle shutdown
let isShuttingDown = false;

async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('Shutting down bot...');
    try {
        // Destroy the client
        await client.destroy();
        console.log('Bot disconnected successfully');
    } catch (error) {
        console.error('Error during shutdown:', error);
    }
    process.exit(0);
}

// Handle process signals
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down...');
    shutdown();
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down...');
    shutdown();
});

// Log in to Discord with your client's token
console.log('Attempting to log in...');

// Add a delay between reconnection attempts
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000; // 5 seconds

async function login(): Promise<void> {
    try {
        await client.login(process.env.DISCORD_TOKEN);
        reconnectAttempts = 0; // Reset attempts on successful login
    } catch (error) {
        console.error('Failed to log in:', error);
        reconnectAttempts++;
        
        if (reconnectAttempts < maxReconnectAttempts) {
            console.log(`Retrying in ${reconnectDelay/1000} seconds... (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
            setTimeout(login, reconnectDelay);
        } else {
            console.error('Max reconnection attempts reached. Please check your internet connection and Discord token.');
            process.exit(1);
        }
    }
}

// Initialize the bot
async function init(): Promise<void> {
    try {
        // Load commands first
        await loadCommands();
        
        // Start the bot if not in production
        if (process.env.NODE_ENV !== 'production') {
            await login();
        }
    } catch (error) {
        console.error('Failed to initialize bot:', error);
        process.exit(1);
    }
}

// Start the bot
init(); 