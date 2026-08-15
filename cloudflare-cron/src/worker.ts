/// <reference types="@cloudflare/workers-types" />

export interface Env {
  CRON_SECRET: string;
  VERCEL_BASE_URL: string;
}

const ENDPOINTS = ['/api/check-prices', '/api/server-status', '/api/amp-status'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const status = {
      message: 'WrongSpecBot Cron Worker is running',
      endpoints: ENDPOINTS,
      schedule: 'Every minute',
    };
    return new Response(JSON.stringify(status, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered at:', new Date(event.scheduledTime).toISOString());

    await Promise.allSettled(
      ENDPOINTS.map(async (endpoint) => {
        const url = env.VERCEL_BASE_URL + endpoint;
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': 'Bearer ' + env.CRON_SECRET,
              'User-Agent': 'Cloudflare-Cron-Worker',
            },
          });

          const data = await response.json();
          console.log(endpoint + ' response:', response.status, JSON.stringify(data));

          if (!response.ok) {
            console.error(endpoint + ' failed:', response.status, data);
          }
        } catch (error) {
          // Log url, name, and message explicitly - Cloudflare's structured logging can drop
          // the message when only an Error object is passed, hiding e.g. a malformed VERCEL_BASE_URL.
          const name = error instanceof Error ? error.name : typeof error;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error calling ${endpoint} (url=${url}): ${name}: ${message}`, error);
        }
      })
    );
  },
};
