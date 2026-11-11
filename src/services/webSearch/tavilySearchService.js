'use strict'
const { error, setting } = require('../financial/httpClient')

const SEARCH_URL = 'https://api.tavily.com/search'
const MAX_RESPONSE_BYTES = 500000
const ALLOWED_TOPICS = new Set(['general', 'news', 'finance'])

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

function safeResultUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
    } catch {
        return null
    }
}

function createTavilySearch(env = {}, { fetchImpl = fetch, signal, now = () => Date.now() } = {}) {
    const stats = { calls: 0 }
    async function search({ query, topic = 'general' }) {
        if (!env.TAVILY_API_KEY) throw error('CHAVE_AUSENTE')
        if (typeof query !== 'string' || !query.trim() || query.length > 400) throw error('ARGUMENTO_INVALIDO')
        if (!ALLOWED_TOPICS.has(topic)) throw error('VALOR_NAO_PERMITIDO:topic')
        if (stats.calls >= setting(env, 'FINANCIAL_MAX_WEB_SEARCHES', 1, 3)) throw error('LIMITE_BUSCA_WEB')
        signal?.throwIfAborted()
        stats.calls++

        const timeout = AbortSignal.timeout(Math.max(100, setting(env, 'TAVILY_HTTP_TIMEOUT_MS', 8000, 15000)))
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        let response
        try {
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
                redirect: 'error',
                signal: requestSignal,
            })
        } catch {
            signal?.throwIfAborted()
            throw error('PROVEDOR_INDISPONIVEL')
        }

        if (!response.ok) {
            const status = response.status
            await response.body?.cancel().catch(() => {})
            const code = status === 400 || status === 422 ? 'PARAMETROS_PROVEDOR'
                : status === 401 ? 'AUTENTICACAO'
                : status === 403 || status === 432 || status === 433 ? 'PLANO_OU_PERMISSAO'
                : status === 429 ? 'COTA_EXCEDIDA'
                : 'PROVEDOR_INDISPONIVEL'
            throw error(code, status)
        }

        const data = await readJson(response)
        if (!data || !Array.isArray(data.results)) throw error('RESPOSTA_INVALIDA')
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

        return {
            tipo: 'pesquisa_web',
            fonte: 'Tavily',
            consultadoEm: new Date(now()).toISOString(),
            topico: topic,
            resultados,
        }
    }

    return { search, stats }
}

module.exports = { createTavilySearch }
