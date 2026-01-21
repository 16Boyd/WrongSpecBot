import { Client, GatewayIntentBits } from 'discord.js';
import { checkPrices } from '../src/tasks/checkPrices';
import Logger from '../src/lib/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Initialize Discord client for notifications
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

interface ApiResponse {
    status?: 'completed' | 'error';
    message: string;
    error?: string;
    result?: any;
    timestamp: string;
}

// Export the handler for Vercel
export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    const logger = new Logger('check-prices-api');
    
    try {
        logger.info('VERCEL CHECK-PRICES FUNCTION STARTED');
        logger.info('Request details', {
            method: req.method,
            headers: req.headers,
            userAgent: req.headers['user-agent']
        });
        
        //Check for UptimeRobot by examining the user-agent
        const userAgent = req.headers['user-agent'] || '';
        const isUptimeRobot = userAgent.includes('UptimeRobot');
        
        logger.info('Authorization check', { 
            userAgent,
            isUptimeRobot 
        });
        
        if (!isUptimeRobot) {
            logger.warn('Request not from UptimeRobot, returning unauthorized');
            await logger.flush();
            return res.status(401).json({ 
                message: 'Unauthorized',
                timestamp: new Date().toISOString()
            });
        }

        logger.info('Request authorized, starting price check...');
        
        // Process synchronously to ensure logs are written
        try {
            const result = await checkPrices();
            logger.info('Price check completed successfully', result as unknown as Record<string, unknown>);
            logger.info('VERCEL CHECK-PRICES FUNCTION COMPLETED');
            await logger.flush();
            
            return res.status(200).json({ 
                status: 'completed',
                message: 'Price check completed successfully',
                result,
                timestamp: new Date().toISOString()
            });
        } catch (priceCheckError) {
            const error = priceCheckError as Error;
            logger.error('Error in price check', {
                message: error.message,
                stack: error.stack
            });
            await logger.flush();
            
            return res.status(500).json({ 
                status: 'error',
                message: 'Price check failed',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        
    } catch (error) {
        const err = error as Error;
        logger.error('Error in check-prices endpoint', {
            message: err.message,
            stack: err.stack
        });
        logger.error('VERCEL CHECK-PRICES FUNCTION ERROR');
        await logger.flush();
        
        return res.status(500).json({ 
            message: 'Internal server error',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
} 