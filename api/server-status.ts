import { checkServerStatus } from '../src/tasks/checkServerStatus';
import Logger from '../src/lib/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    const logger = new Logger('server-status-api');
    
    try {
        logger.info('VERCEL SERVER-STATUS FUNCTION STARTED');
        
        // Check authorization: UptimeRobot or Bearer token
        const userAgent = req.headers['user-agent'] || '';
        const authHeader = req.headers['authorization'] || '';
        const isUptimeRobot = userAgent.includes('UptimeRobot');
        const hasValidToken = authHeader === `Bearer ${process.env.CRON_SECRET}`;
        
        logger.info('Authorization check', { 
            userAgent,
            isUptimeRobot,
            hasAuthHeader: !!authHeader
        });
        
        if (!isUptimeRobot && !hasValidToken) {
            logger.warn('Request unauthorized');
            await logger.flush();
            res.status(401).json({ 
                message: 'Unauthorized',
                timestamp: new Date().toISOString()
            });
            return;
        }

        logger.info('Request authorized, checking server status...');
        
        const result = await checkServerStatus();
        logger.info('Server status check completed', result as unknown as Record<string, unknown>);
        await logger.flush();
        
        res.status(200).json({ 
            status: 'completed',
            message: 'Server status check completed',
            result,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        const err = error as Error;
        logger.error('Error in server-status endpoint', {
            message: err.message,
            stack: err.stack
        });
        await logger.flush();
        
        res.status(500).json({ 
            message: 'Internal server error',
            error: err.message,
            timestamp: new Date().toISOString()
        });
    }
}
