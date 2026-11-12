// Adaptador Node para copiar/importar no back-end separado. Não é executado pelo Worker.
const WORKER_URL_PADRAO = 'https://ia-fimap.fimap-agency.workers.dev/v1/ia/chat'
const { parseEvent } = require('./chatProtocol.js')
const criarErro = (message, code) => Object.assign(new Error(message), { code })
const isConfigurado = () => Boolean(process.env.CLOUDFLARE_WORKER_URL && process.env.CLOUDFLARE_CHAT_TOKEN)
async function gerarResposta(messages, onChunk, signal) {
    const url = process.env.CLOUDFLARE_WORKER_URL || WORKER_URL_PADRAO
    const token = process.env.CLOUDFLARE_CHAT_TOKEN
    let response
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ messages }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
        })
    } catch (error) {
        signal?.throwIfAborted()
        throw criarErro(error.name === 'TimeoutError' ? 'A IA demorou demais para responder.' : 'Não foi possível conectar à IA.', 'IA_INDISPONIVEL')
    }
    if (!response.ok) {
        await response.body?.cancel()
        throw criarErro(`O serviço de IA respondeu com status ${response.status}.`, 'IA_PROVEDOR')
    }
    if (!response.body) throw criarErro('A IA não retornou um fluxo.', 'IA_RESPOSTA_INVALIDA')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', result = '', complete = false
    const handleEvent = event => {
        const parsed = parseEvent(event)
        if (parsed?.error) throw criarErro(parsed.error, 'IA_FLUXO_INTERROMPIDO')
        if (parsed?.done) complete = true
        if (parsed?.text) { result += parsed.text; onChunk(parsed.text) }
    }
    try {
        while (!complete) {
            const { value, done } = await reader.read()
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
            const events = buffer.split(/\r?\n\r?\n/)
            buffer = events.pop() || ''
            for (const event of events) { handleEvent(event); if (complete) break }
            signal?.throwIfAborted()
            if (done) { if (!complete && buffer.trim()) handleEvent(buffer); break }
        }
        signal?.throwIfAborted()
        if (!complete) throw criarErro('A conexão terminou antes da conclusão da resposta.', 'IA_FLUXO_INTERROMPIDO')
        if (!result.trim()) throw criarErro('A IA retornou uma resposta vazia.', 'IA_RESPOSTA_VAZIA')
        return result.trim()
    } catch (error) {
        signal?.throwIfAborted()
        if (error.code) throw error
        throw criarErro('A conexão com a IA foi interrompida.', 'IA_FLUXO_INTERROMPIDO')
    } finally { await reader.cancel().catch(() => {}) }
}
module.exports = { isConfigurado, gerarResposta }
