export interface Env {
  CRON_SECRET: string;
  VERCEL_API_URL: string;
}

export default {
  // HTTP handler (for manual testing)
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response('WoW Token Cron Worker is running. Cron triggers every minute.', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },

  // Cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron triggered at:', new Date(event.scheduledTime).toISOString());

    try {
      const response = await fetch(env.VERCEL_API_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${env.CRON_SECRET}`,
          'User-Agent': 'Cloudflare-Cron-Worker',
        },
      });

      const data = await response.json();
      console.log('Price check response:', response.status, JSON.stringify(data));

      if (!response.ok) {
        console.error('Price check failed:', response.status, data);
      }
    } catch (error) {
      console.error('Error calling Vercel API:', error);
    }
  },
};
