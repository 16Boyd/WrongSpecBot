import { checkServerStatus } from '../src/tasks/checkServerStatus';
import Logger from '../src/lib/logger';
import type { VercelRequest, VercelResponse } from '@vercel/node';

interface ApiResponse {
    status?: 'completed' | 'error';
    message: string;
    error?: string;
    result?: unknown;
    timestamp: string;
}

// Export the handler for Vercel
export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    const logger = new Logger('server-status-api');
    
    try {
        logger.info('VERCEL SERVER-STATUS FUNCTION STARTED');
        logger.info('Request details', {
            method: req.method,
            headers: req.headers,
            userAgent: req.headers['user-agent']
        });
        
        // Check authorization: UptimeRobot user-agent OR Bearer token
        const userAgent = req.headers['user-agent'] || '';
        const authHeader = req.headers['authorization'] || '';
        const isUptimeRobot = userAgent.includes('UptimeRobot');
        const isCloudflare = userAgent.includes('Cloudflare-Cron-Worker');
        const hasValidToken = authHeader === `Bearer ${process.env.CRON_SECRET}`;
        
        logger.info('Authorization check', { 
            userAgent,
            isUptimeRobot,
            isCloudflare,
            hasAuthHeader: !!authHeader
        });
        
        // Allow UptimeRobot OR valid Bearer token (from Cloudflare)
        if (!isUptimeRobot && !hasValidToken) {
            logger.warn('Request unauthorized - not UptimeRobot and no valid token');
            await logger.flush();
            res.status(401).json({ 
                message: 'Unauthorized',
                timestamp: new Date().toISOString()
            });
            return;
        }

        logger.info('Request authorized, starting server status check...', {
            authMethod: isUptimeRobot ? 'UptimeRobot' : 'Bearer Token'
        });
        
        // Process the server status check
        try {
            const result = await checkServerStatus();
            logger.info('Server status check completed', result as unknown as Record<string, unknown>);
            logger.info('VERCEL SERVER-STATUS FUNCTION COMPLETED');
            await logger.flush();
            
            res.status(200).json({ 
                status: 'completed',
                message: 'Server status check completed successfully',
                result,
                timestamp: new Date().toISOString()
            });
            return;
        } catch (statusCheckError) {
            const error = statusCheckError as Error;
            logger.error('Error in server status check', {
                message: error.message,
                stack: error.stack
            });
            await logger.flush();
            
            res.status(500).json({ 
                status: 'error',
                message: 'Server status check failed',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            return;
        }
        
    } catch (error) {
        const err = error as Error;
        logger.error('Error in server-status endpoint', {
            message: err.message,
            stack: err.stack
        });
        logger.error('VERCEL SERVER-STATUS FUNCTION ERROR');
        await logger.flush();
        
        res.status(500).json({ 
            message: 'Internal server error',
            error: err.message,
            timestamp: new Date().toISOString()
        });
        return;
    }
}
