'use strict'
/*
 * Faz a pesquisa na internet quando a IA pede a ferramenta pesquisarWeb.
 * Envia a consulta à Tavily usando o secret TAVILY_API_KEY e recebe até cinco resultados.
 * Entrega títulos, links e trechos para a IA preparar sua resposta e citar as fontes.
 * Não salva um histórico de buscas nem implementa cache neste arquivo.
 */
const { error, setting } = require('../financial/httpClient')

// O endereço é fixo: a IA escolhe os termos da busca, não o servidor que recebe a chave.
const SEARCH_URL = 'https://api.tavily.com/search'
const MAX_RESPONSE_BYTES = 500000
const ALLOWED_TOPICS = new Set(['general', 'news', 'finance'])

// Executada quando a Tavily responde. Lê o JSON em pedaços e limita o tamanho,
// inclusive se a resposta não informar antecipadamente quantos bytes serão enviados.
async function readJson(response) {
    if (!response.body) throw error('RESPOSTA_INVALIDA')
    const declaredBytes = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) throw error('RESPOSTA_GRANDE')
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    const decoder = new TextDecoder()
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw error('RESPOSTA_GRANDE')
            chunks.push(decoder.decode(value, { stream: true }))
        }
        chunks.push(decoder.decode())
        try { return JSON.parse(chunks.join('')) }
        catch { throw error('RESPOSTA_INVALIDA') }
    } finally {
        await reader.cancel().catch(() => {})
    }
}

// Antes de entregar um link à IA, aceita apenas endereço HTTPS válido, sem login
// embutido. Links fora desse formato são descartados do resultado.
function safeResultUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
    } catch {
        return null
    }
}

// Prepara a pesquisa para uma pergunta. A rede e o relógio podem ser substituídos
// nos testes; em produção usamos fetch e o horário real.
function createTavilySearch(env = {}, { fetchImpl = fetch, signal, now = () => Date.now() } = {}) {
    // Conta buscas desta pergunta para aplicar o limite e informar uso nos logs.
    const stats = { calls: 0 }
    // Executada só quando a IA escolhe pesquisarWeb. Confere a chave, o texto,
    // o assunto e o limite antes de gastar uma consulta no fornecedor.
    async function search({ query, topic = 'general' }) {
        if (!env.TAVILY_API_KEY) throw error('CHAVE_AUSENTE')
        if (typeof query !== 'string' || !query.trim() || query.length > 400) throw error('ARGUMENTO_INVALIDO')
        if (!ALLOWED_TOPICS.has(topic)) throw error('VALOR_NAO_PERMITIDO:topic')
        if (stats.calls >= setting(env, 'FINANCIAL_MAX_WEB_SEARCHES', 1, 3)) throw error('LIMITE_BUSCA_WEB')
        signal?.throwIfAborted()
        stats.calls++

        // A busca tem prazo e também pode parar por cancelamento da pergunta.
        const timeout = AbortSignal.timeout(Math.max(100, setting(env, 'TAVILY_HTTP_TIMEOUT_MS', 8000, 15000)))
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        let response
        try {
            // Pede resultados de busca, sem uma resposta pronta da Tavily e sem
            // o conteúdo completo das páginas. A própria IA vai montar a resposta.
            response = await fetchImpl(SEARCH_URL, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    Authorization: 'Bearer ' + env.TAVILY_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: query.trim(),
                    topic,
                    search_depth: 'basic',
                    max_results: 5,
                    include_answer: false,
                    include_raw_content: false,
                    include_published_date: true,
                }),
                redirect: 'manual',
                signal: requestSignal,
            })
        } catch {
            signal?.throwIfAborted()
            throw error('PROVEDOR_INDISPONIVEL')
        }

        // Se o fornecedor recusar, devolve um código conhecido para a IA explicar
        // a falha. Não segue redirecionamentos e não devolve a chave ou o erro bruto.
        if (!response.ok) {
            const status = response.status
            await response.body?.cancel().catch(() => {})
            if (status >= 300 && status < 400) throw error('REDIRECIONAMENTO_NAO_PERMITIDO', status)
            const code = status === 400 || status === 422 ? 'PARAMETROS_PROVEDOR'
                : status === 401 ? 'AUTENTICACAO'
                : status === 403 || status === 432 || status === 433 ? 'PLANO_OU_PERMISSAO'
                : status === 429 ? 'COTA_EXCEDIDA'
                : 'PROVEDOR_INDISPONIVEL'
            throw error(code, status)
        }

        const data = await readJson(response)
        if (!data || !Array.isArray(data.results)) throw error('RESPOSTA_INVALIDA')
        // Reduz os resultados aos campos e tamanhos necessários. A data de
        // publicação vem da fonte; não é substituída pela data da busca.
        const resultados = data.results.slice(0, 5).flatMap(item => {
            const url = safeResultUrl(item?.url)
            if (!url) return []
            return [{
                titulo: typeof item.title === 'string' ? item.title.slice(0, 240) : '',
                url,
                trecho: typeof item.content === 'string' ? item.content.slice(0, 1200) : '',
                publicadoEm: typeof item.published_date === 'string' ? item.published_date.slice(0, 100) : null,
            }]
        })

        // O orchestrator recebe estes dados e os coloca na conversa temporária da IA.
        return {
            tipo: 'pesquisa_web',
            fonte: 'Tavily',
            consultadoEm: new Date(now()).toISOString(),
            topico: topic,
            resultados,
        }
    }

    // Expõe a função e sua contagem. Criar este serviço ainda não faz nenhuma busca.
    return { search, stats }
}

module.exports = { createTavilySearch }
