import presentationPrompt from './ai-presentation-prompt.js';
import systemPrompt from './ai-system-prompt.js';
import financialChat from './services/financial/financialChatOrchestrator.js';
import protocol from './services/chatProtocol.js';
import aiProvider from './services/aiProvider.js';
import aiModel from './ai-model.js';

export type Env = {
  AI?: Ai;
  AI_PROVIDER_ACCOUNT_ID?: string;
  AI_PROVIDER_API_TOKEN?: string;
  CHAT_RATE_LIMITER: RateLimit;
  CHAT_API_TOKEN?: string;
  ALLOWED_ORIGINS?: string;
  HG_BRASIL_API_KEY?: string;
  BRAPI_TOKEN?: string;
  TAVILY_API_KEY?: string;
  GEOAPIFY_API_KEY?: string;
  FINANCIAL_TOOLS_ENABLED?: string;
  FINANCIAL_MAX_WEB_SEARCHES?: string;
  TAVILY_HTTP_TIMEOUT_MS?: string;
};
const { MODEL } = aiModel;
const lastRequest = new Map<string, number>();
let lastCleanup = Date.now();
type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = [url.origin, ...(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)];
    const originAllowed = !origin || allowed.includes(origin);
    const headers = new Headers({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Retry-After',
    });
    if (origin && originAllowed) headers.set('Access-Control-Allow-Origin', origin);
    const json = (body: unknown, status = 200, retry?: number) => {
      const result = new Headers(headers);
      if (retry) result.set('Retry-After', String(retry));
      return Response.json(body, { status, headers: result });
    };
    if (!originAllowed) return json({ mensagem: 'Origem não autorizada.' }, 403);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ online: true, service: 'ia-fimap', iaConfigurada: aiProvider.isAiConfigured(env), configuracaoIA: aiProvider.configurationStatus(env), verificacaoIA: 'somente-formato', provedorIA: aiProvider.usesExternalAccount(env) ? 'conta-externa' : 'conta-do-worker', model: MODEL });
    }
    const publicRoute = url.pathname === '/v1/ia/chat-publico';
    const privateRoute = url.pathname === '/v1/ia/chat';
    const legacyRoute = url.pathname === '/chat';
    if (!publicRoute && !privateRoute && !legacyRoute) return json({ mensagem: 'Rota não encontrada.' }, 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ mensagem: 'Use POST para enviar mensagens.' }, 405);
    if (!publicRoute) {
      if (!env.CHAT_API_TOKEN) return json({ mensagem: 'A integração com o back-end ainda não foi configurada.' }, 503);
      if (request.headers.get('Authorization') !== `Bearer ${env.CHAT_API_TOKEN}`) return json({ mensagem: 'Token da integração inválido.' }, 401);
    }
    if (Number(request.headers.get('Content-Length')) > 262144) return json({ mensagem: 'Requisição muito grande.' }, 413);
    let messages: Message[];
    try {
      const raw = await request.text();
      if (raw.length > 262144) return json({ mensagem: 'Requisição muito grande.' }, 413);
      const body = JSON.parse(raw) as { messages?: unknown };
      if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 12) return json({ mensagem: 'Envie de 1 a 12 mensagens.' }, 400);
      const valid = body.messages.every(item => {
        if (!item || typeof item !== 'object') return false;
        const { role, content } = item;
        const roles = legacyRoute ? ['system', 'user', 'assistant'] : ['user', 'assistant'];
        const shared = legacyRoute && role === 'system' && (content === systemPrompt || content === systemPrompt + '\n' + presentationPrompt);
        return roles.includes(role) && typeof content === 'string' && content.trim().length > 0 &&
          (shared || content.length <= (role === 'assistant' ? 16000 : 2000));
      });
      if (!valid || body.messages.at(-1)?.role !== 'user') return json({ mensagem: 'Mensagens inválidas. Termine com uma pergunta de até 2000 caracteres.' }, 400);
      messages = body.messages;
    } catch { return json({ mensagem: 'O corpo precisa ser um JSON válido.' }, 400); }

    if (!aiProvider.isAiConfigured(env)) return json({ mensagem: 'A conexão com a IA ainda não está configurada.' }, 503);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    if (now - lastCleanup > 60000) {
      for (const [key, time] of lastRequest) if (now - time >= 60000) lastRequest.delete(key);
      lastCleanup = now;
    }
    const previous = lastRequest.get(ip);
    if (previous && now - previous < 5000) {
      const retry = Math.ceil((5000 - (now - previous)) / 1000);
      return json({ mensagem: `Aguarde ${retry} segundo(s) antes de enviar outra pergunta.` }, 429, retry);
    }
    const release = () => { if (lastRequest.get(ip) === now) lastRequest.delete(ip); };
    lastRequest.set(ip, now);
    try {
      const limit = await env.CHAT_RATE_LIMITER.limit({ key: ip });
      if (!limit.success) { release(); return json({ mensagem: 'Limite de uso atingido. Tente novamente em um minuto.' }, 429, 60); }
      const conversation = legacyRoute && messages[0]?.role === 'system' ? messages
        : [{ role: 'system', content: systemPrompt + '\n' + presentationPrompt }, ...messages];
      const prepared = await financialChat.prepareFinancialMessages(conversation, env,
        (inputs: Ai_Cf_Google_Gemma_4_26B_A4B_It_Input) => aiProvider.runAi(env, MODEL, inputs, request.signal),
        { signal: request.signal, logger: (data: unknown) => console.info(JSON.stringify(data)) });
      request.signal.throwIfAborted();
      const source = await aiProvider.runAi(env, MODEL, {
        messages: prepared,
        stream: true,
        max_completion_tokens: 4096,
        temperature: 0.4,
        chat_template_kwargs: { enable_thinking: false },
      }, request.signal);
      if (!source || typeof (source as ReadableStream).getReader !== 'function') throw new Error('INVALID_STREAM');
      const stream = legacyRoute ? source as ReadableStream : protocol.createPublicStream(source, release);
      const streamHeaders = new Headers(headers);
      streamHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
      streamHeaders.set('Cache-Control', 'no-cache, no-transform');
      return new Response(stream, { headers: streamHeaders });
    } catch (cause) {
      release();
      if (request.signal.aborted) return json({ mensagem: 'Geração cancelada.' }, 499);
      const error = aiProvider.publicFailure(cause);
      console.error(JSON.stringify({ evento: 'ai_error', codigo: error.code }));
      return json({ mensagem: error.message, codigo: error.code }, error.status, error.retryAfter);
    }
  },
} satisfies ExportedHandler<Env>;
