/// <reference types="@cloudflare/workers-types" />

export interface Env {
  CRON_SECRET: string;
  VERCEL_BASE_URL: string;
}

const ENDPOINTS = ['/api/check-prices'];

export default {
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered at:', new Date(event.scheduledTime).toISOString());

    for (const endpoint of ENDPOINTS) {
      try {
        const url = env.VERCEL_BASE_URL + endpoint;
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
        console.error('Error calling ' + endpoint + ':', error);
      }
    }
  },
};
