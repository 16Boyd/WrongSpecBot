import type { VercelRequest } from '@vercel/node';

// The cron endpoints are triggered by the Cloudflare Worker with a shared bearer secret.
// Returns false when CRON_SECRET is unset so a misconfigured deploy fails closed rather
// than accepting a literal "Bearer undefined".
export function isCronAuthorized(req: VercelRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return false;
    }
    const authHeader = req.headers['authorization'] || '';
    return authHeader === `Bearer ${secret}`;
}
