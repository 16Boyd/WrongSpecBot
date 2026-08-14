import type { VercelRequest, VercelResponse } from '@vercel/node';

// Import handlers
import interactionsHandler from './interactions';

// Route handler
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    const path = req.url || '';

    // Log the incoming request
    console.log(`Received request to ${path}`);

    // Route to appropriate handler
    if (path === '/api/interactions') {
        await interactionsHandler(req, res);
        return;
    }

    console.log(`No handler found for path: ${path}`);
    res.status(404).json({
        error: 'Not found',
        path: path,
        availableEndpoints: ['/api/interactions']
    });
} 