import { checkPrices } from '../src/tasks/checkPrices';
import Logger from '../src/lib/logger';
import { isCronAuthorized } from '../src/lib/auth';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Export the handler for Vercel
export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    const logger = new Logger('check-prices-api');

    try {
        logger.info('Check-prices function started', { method: req.method });

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

        logger.info('Request authorized, starting price check...');

        try {
            const result = await checkPrices();
            logger.info('Price check completed successfully', result as unknown as Record<string, unknown>);
            await logger.flush();

            res.status(200).json({
                status: 'completed',
                message: 'Price check completed successfully',
                result,
                timestamp: new Date().toISOString()
            });
            return;
        } catch (priceCheckError) {
            const error = priceCheckError as Error;
            logger.error('Error in price check', {
                message: error.message,
                stack: error.stack
            });
            await logger.flush();

            res.status(500).json({
                status: 'error',
                message: 'Price check failed',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            return;
        }
    } catch (error) {
        const err = error as Error;
        logger.error('Error in check-prices endpoint', {
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
