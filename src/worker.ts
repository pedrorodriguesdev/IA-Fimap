import api, { type Env } from './index';

type WebEnv = Env & { ASSETS: Fetcher };
export default {
  async fetch(request: Request, env: WebEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.toLowerCase().replace(/\/+$/, '') === '/pluggy.html') {
      return new Response('Página não disponível.', { status: 404 });
    }
    if (path.startsWith('/v1/') || path === '/chat' || path === '/health') {
      return api.fetch(request, env);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<WebEnv>;
