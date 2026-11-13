/*
 * Este arquivo é a ligação com o modelo da IA na Cloudflare.
 * Ele é chamado tanto para a IA escolher ferramentas quanto para escrever a resposta.
 * Recebe mensagens, modelo e opções; envia isso à conta configurada e devolve o resultado.
 * As APIs de ações, dólar etc. são chamadas pelos outros serviços, não por este arquivo.
 * Ele não guarda conversas nem troca de conta sozinho quando a cota acaba.
 */

// Traduz problemas da Cloudflare para mensagens que podemos mostrar ao usuário,
// sem repassar a resposta bruta do fornecedor ou suas credenciais.
const failures = {
    AI_CONFIGURATION: [503, 'A conexão com a IA ainda não está configurada.'],
    AI_PROVIDER_AUTH: [503, 'A credencial da conta de IA foi recusada.'],
    AI_PROVIDER_ACCESS: [503, 'A conta de IA não tem acesso ao modelo configurado.'],
    AI_QUOTA: [429, 'A cota diária da conta de IA foi atingida. Aguarde a renovação da cota.'],
    AI_RATE_LIMIT: [429, 'A IA recebeu muitos pedidos. Aguarde um pouco e tente novamente.'],
    AI_PROVIDER_REDIRECT: [503, 'A conexão com a conta de IA foi recusada.'],
    AI_INVALID_RESPONSE: [502, 'A IA retornou uma resposta inválida. Tente novamente.'],
    AI_UNAVAILABLE: [502, 'Não foi possível gerar a resposta. Tente novamente em instantes.'],
}

// Quando algo falha, monta um erro conhecido. fatalAiError avisa ao coordenador
// que repetir a chamada nessa pergunta não vai resolver, como no caso de cota esgotada.
function failure(code) {
    const [status, message] = failures[code]
    return Object.assign(new Error(message), {
        code, status, aiProviderError: true,
        fatalAiError: !['AI_UNAVAILABLE', 'AI_INVALID_RESPONSE'].includes(code),
    })
}

// Basta um dos dois secrets existir para considerar que foi escolhida a conta via REST.
// Assim, uma configuração pela metade dá erro em vez de usar outra conta sem querer.
function usesExternalAccount(env) {
    return env.AI_PROVIDER_ACCOUNT_ID !== undefined || env.AI_PROVIDER_API_TOKEN !== undefined
}

// Antes de chamar a IA, lê os secrets e confere o formato do ID e do token.
// Isso verifica o preenchimento; só uma chamada real confirma acesso, permissão e cota.
function configuration(env) {
    const external = usesExternalAccount(env)
    const account = typeof env.AI_PROVIDER_ACCOUNT_ID === 'string' ? env.AI_PROVIDER_ACCOUNT_ID.trim() : ''
    const token = typeof env.AI_PROVIDER_API_TOKEN === 'string' ? env.AI_PROVIDER_API_TOKEN.trim() : ''
    const ready = external ? /^[a-f0-9]{32}$/i.test(account) && Boolean(token) && !/[\s"'\\]/.test(token) && !/^Bearer$/i.test(token) : typeof env.AI?.run === 'function'
    return { external, account, token, ready }
}

// Usado para informar se os dados necessários à conexão estão preenchidos.
const isAiConfigured = env => configuration(env).ready

// Dá um diagnóstico curto para a rota de saúde do serviço, sem revelar os secrets.
function configurationStatus(env) {
    const config = configuration(env)
    if (config.ready) return 'pronta'
    if (!config.external) return 'ausente'
    return /^[a-f0-9]{32}$/i.test(config.account) ? 'token-invalido' : 'id-conta-invalido'
}

// Quando a Cloudflare recusa o pedido, diferencia cota diária, excesso de pedidos,
// credencial inválida e falta de acesso. Cada problema pede uma mensagem diferente.
function providerFailure(status, payload) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    if (errors.some(item => [3036, 4006].includes(Number(item.code)) || /daily free allocation/i.test(item.message || ''))) return failure('AI_QUOTA')
    if (status === 401) return failure('AI_PROVIDER_AUTH')
    if (status === 403) return failure('AI_PROVIDER_ACCESS')
    if (status === 429) return failure('AI_RATE_LIMIT')
    if (status >= 300 && status < 400) return failure('AI_PROVIDER_REDIRECT')
    return failure('AI_UNAVAILABLE')
}

// Prepara o erro que sai do servidor. Também informa quanto esperar quando houver
// limite de pedidos ou cota diária, em vez de devolver detalhes internos da Cloudflare.
function publicFailure(cause) {
    const error = cause?.aiProviderError ? cause
        : /\b(?:3036|4006)\b|daily free allocation/i.test(cause?.message || '') ? failure('AI_QUOTA')
        : failure('AI_UNAVAILABLE')
    const retryAfter = error.code === 'AI_QUOTA'
        ? Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000)
        : error.code === 'AI_RATE_LIMIT' ? 60 : undefined
    return { code: error.code, status: error.status, message: error.message, retryAfter }
}

// Ponto de entrada: envia uma solicitação ao modelo e devolve o que ele respondeu.
// signal permite parar a solicitação se o usuário cancelar ou a conexão for encerrada.
async function runAi(env, model, inputs, signal) {
    const config = configuration(env)
    if (!config.ready) throw failure('AI_CONFIGURATION')
    // Compatibilidade com a ligação direta env.AI, quando ela existe e não há secrets REST.
    // Isso não é uma segunda tentativa caso a conta externa falhe.
    if (!config.external) return env.AI.run(model, inputs)
    if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) throw failure('AI_CONFIGURATION')

    signal?.throwIfAborted()
    try {
        // Dá até dois minutos à Cloudflare. O token é enviado apenas ao endereço fixo
        // da API; não seguimos redirecionamentos para outros endereços.
        const timeout = AbortSignal.timeout(120000)
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account}/ai/run/${model}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(inputs),
            redirect: 'manual',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw providerFailure(response.status, payload)
        }
        // Na resposta final, o texto pode chegar em pedaços (stream). Entregamos esse
        // fluxo ao chamador sem esperar que todo o texto fique pronto.
        if (inputs.stream && response.headers.get('Content-Type')?.includes('text/event-stream') && response.body) return response.body
        // Para escolher ferramentas, esperamos um objeto completo, com as chamadas
        // solicitadas pela IA. Removemos apenas o envelope da API da Cloudflare.
        const payload = await response.json().catch(() => null)
        if (payload?.success === false || payload?.errors?.length) throw providerFailure(response.status, payload)
        const result = payload && Object.hasOwn(payload, 'result') ? payload.result : payload
        if (inputs.stream || !result || typeof result !== 'object' || Array.isArray(result)) throw failure('AI_INVALID_RESPONSE')
        return result
    } catch (cause) {
        // Cancelamento continua sendo cancelamento. Outros erros de rede viram uma
        // mensagem conhecida, sem expor detalhes internos ao usuário.
        signal?.throwIfAborted()
        if (cause.aiProviderError) throw cause
        throw failure('AI_UNAVAILABLE')
    }
}

module.exports = { runAi, isAiConfigured, configurationStatus, usesExternalAccount, publicFailure }
