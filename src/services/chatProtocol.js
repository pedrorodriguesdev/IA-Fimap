// Protocolo compartilhado pelo Worker e pelo adaptador Node.
function parseEvent(event) {
    const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!payload) return null
    if (payload === '[DONE]') return { done: true }
    let data
    try { data = JSON.parse(payload) } catch { return { error: 'A IA retornou um evento inválido.' } }
    if (data.error || data.tipo === 'erro') return { error: 'A IA não conseguiu concluir a resposta. Tente novamente.' }
    if (data.tipo === 'fim') return { done: true }
    const text = data.conteudo ?? data.response ?? data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content
    return typeof text === 'string' ? { text } : null
}

function createPublicStream(source, onCancel = () => {}) {
    const reader = source.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = '', cancelled = false, terminal = false, visible = false
    const send = (controller, data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
    const finish = (controller, error) => {
        if (terminal || cancelled) return
        terminal = true
        send(controller, error || !visible
            ? { tipo: 'erro', mensagem: error || 'A IA retornou uma resposta vazia. Tente novamente.' }
            : { tipo: 'fim' })
        controller.close()
    }
    const process = (event, controller) => {
        const parsed = parseEvent(event)
        if (parsed?.error) { finish(controller, parsed.error); return }
        if (parsed?.done) { finish(controller); return }
        if (parsed?.text) {
            visible = visible || Boolean(parsed.text.trim())
            send(controller, { tipo: 'trecho', conteudo: parsed.text })
            return true
        }
    }
    return new ReadableStream({
        async pull(controller) {
            try {
                while (!terminal && !cancelled) {
                    const { value, done } = await reader.read()
                    if (cancelled) return
                    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
                    const events = buffer.split(/\r?\n\r?\n/)
                    buffer = events.pop() || ''
                    let sent = false
                    for (const event of events) {
                        sent = process(event, controller) || sent
                        if (terminal) break
                    }
                    if (done && !terminal) {
                        if (buffer.trim()) process(buffer, controller)
                        if (!terminal) finish(controller, 'A conexão terminou antes de concluir a resposta. Tente novamente.')
                    }
                    if (terminal) { await reader.cancel().catch(() => {}); return }
                    if (sent) return
                }
            } catch {
                if (!cancelled && !terminal) finish(controller, 'A conexão com a IA foi interrompida.')
                await reader.cancel().catch(() => {})
            }
        },
        cancel(reason) { cancelled = true; onCancel(); return reader.cancel(reason) }
    })
}
module.exports = { parseEvent, createPublicStream }
