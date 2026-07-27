import { checkAmpStatus } from '../src/tasks/checkAmpStatus';
import Logger from '../src/lib/logger';
import { isCronAuthorized } from '../src/lib/auth';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    const logger = new Logger('amp-status-api');

    try {
        logger.info('AMP-status function started', { method: req.method });

        // Triggered by the Cloudflare Worker with a shared bearer secret.
        if (!isCronAuthorized(req)) {
            logger.warn('Request unauthorized - missing or invalid bearer token');
            await logger.flush();
            res.status(401).json({
                message: 'Unauthorized',
                timestamp: new Date().toISOString()
            });
            return;
        }

        logger.info('Request authorized, checking AMP instance status...');

        const result = await checkAmpStatus();
        logger.info('AMP status check completed', result as unknown as Record<string, unknown>);
        await logger.flush();

        res.status(200).json({
            status: 'completed',
            message: 'AMP status check completed',
            result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const err = error as Error;
        logger.error('Error in amp-status endpoint', {
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
