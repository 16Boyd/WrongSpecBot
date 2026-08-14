import type { VercelRequest } from '@vercel/node';
import { LogLike, consoleLog } from './logger';

export interface CronAuthResult {
    authorized: boolean;
    authMethod: 'UptimeRobot' | 'Bearer Token' | null;
}

// Authorize a scheduled-task endpoint request: either UptimeRobot's monitoring user-agent,
// or a valid Bearer token (used by the Cloudflare Worker cron trigger).
export function checkCronAuth(req: VercelRequest, logger: LogLike = consoleLog): CronAuthResult {
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

    const authorized = isUptimeRobot || hasValidToken;
    const authMethod = authorized ? (isUptimeRobot ? 'UptimeRobot' : 'Bearer Token') : null;

    return { authorized, authMethod };
}
