/// <reference types="@cloudflare/workers-types" />

export interface Env {
  CRON_SECRET: string;
  VERCEL_BASE_URL: string;  // Base URL like https://your-app.vercel.app
}

// Endpoints to call on each cron trigger
const ENDPOINTS = [
  '/api/check-prices',
  '/api/server-status',
];

export default {
  // HTTP handler (for manual testing)
  async fetch(request: Request, env: Env): Promise<Response> {
    const status = {
      message: 'WoW Token Cron Worker is running',
      endpoints: ENDPOINTS,
      schedule: 'Every minute',
    };
    return new Response(JSON.stringify(status, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered at:', new Date(event.scheduledTime).toISOString());

    const results: { endpoint: string; status: number | string; success: boolean }[] = [];

    // Call all endpoints in parallel
    const promises = ENDPOINTS.map(async (endpoint) => {
      try {
        const url = `${env.VERCEL_BASE_URL}${endpoint}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${env.CRON_SECRET}`,
            'User-Agent': 'Cloudflare-Cron-Worker',
          },
        });

        const data = await response.json();
        console.log(`${endpoint} response:`, response.status, JSON.stringify(data));

        results.push({
          endpoint,
          status: response.status,
          success: response.ok,
        });

        if (!response.ok) {
          console.error(`${endpoint} failed:`, response.status, data);
        }
      } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
        results.push({
          endpoint,
          status: 'error',
          success: false,
        });
      }
    });

    await Promise.all(promises);

    console.log('All endpoints processed:', JSON.stringify(results));
  },
};
