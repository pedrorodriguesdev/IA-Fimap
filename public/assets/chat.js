(() => {
  'use strict'
  const $ = id => document.getElementById(id)
  const base = (window.FIMAP_API_URL || '').replace(/\/+$/, '')
  const form = $('formulario'), input = $('mensagem'), chat = $('conversa')
  const status = $('carregando'), send = $('enviar'), stop = $('parar')
  let controller = null, generation = 0, follow = true
  const history = []
  chat.addEventListener('scroll', () => { follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100 })
  const scroll = () => { if (follow) chat.scrollTop = chat.scrollHeight }
  function resize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 110)}px` }
  input.addEventListener('input', resize)
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() }
  })
  function busy(value) {
    send.disabled = value; send.hidden = value; stop.hidden = !value
    chat.setAttribute('aria-busy', String(value))
  }
  function message(role, text = '') {
    const block = document.createElement('article'); block.className = `message-block ${role}`
    const avatar = document.createElement('span'); avatar.className = 'message-avatar'
    avatar.textContent = role === 'user' ? 'Você' : 'AI'; avatar.setAttribute('aria-hidden', 'true')
    const body = document.createElement('div'); body.className = 'message-body'
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text
    block.setAttribute('aria-label', role === 'user' ? 'Sua mensagem' : 'Resposta da Fimap AI')
    body.append(bubble); block.append(avatar, body); chat.append(block); scroll()
    return { body, bubble }
  }
  async function readStream(response, onText) {
    if (!response.body) throw Error('O serviço não retornou uma resposta.')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', doneEvent = false
    const process = event => {
      const raw = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!raw.trim()) return
      let data
      try { data = JSON.parse(raw) } catch { throw Error('A resposta recebida está incompleta. Tente novamente.') }
      if (data.tipo === 'erro') throw Error(data.mensagem || 'A IA não conseguiu concluir a resposta.')
      if (data.tipo === 'fim') doneEvent = true
      if (data.tipo === 'trecho' && typeof data.conteudo === 'string') onText(data.conteudo)
    }
    try {
      while (!doneEvent) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''
        for (const event of events) { process(event); if (doneEvent) break }
        if (done) { if (!doneEvent && buffer.trim()) process(buffer); break }
      }
      if (!doneEvent) throw Error('A conexão terminou antes de concluir a resposta. Tente novamente.')
    } finally { await reader.cancel().catch(() => {}) }
  }
  async function submit(text, retry = false) {
    text = text.trim()
    if (controller || !text || text.length > 2000) return
    const id = ++generation, active = new AbortController(); controller = active
    let timedOut = false, complete = '', frame = 0
    const timer = setTimeout(() => { timedOut = true; active.abort() }, 180000)
    busy(true); follow = true
    if (!retry) message('user', text)
    input.value = ''; resize()
    const assistant = message('assistant', 'Preparando sua resposta…')
    status.textContent = 'Pensando no seu próximo passo…'
    const render = (final = false) => { if (id !== generation) return; window.FimapRenderer.render(assistant.bubble, complete, final); scroll() }
    try {
      const response = await fetch(`${base}/v1/ia/chat-publico`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history.slice(-10), { role: 'user', content: text }] }), signal: active.signal
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw Error(error.mensagem || `Não foi possível conversar com a IA (HTTP ${response.status}).`)
      }
      if (!response.headers.get('Content-Type')?.includes('text/event-stream')) throw Error('O serviço retornou um formato inesperado.')
      await readStream(response, chunk => {
        if (id !== generation) return
        complete += chunk; status.textContent = 'Fimap AI está respondendo…'
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() })
      })
      if (id !== generation) return
      if (!complete.trim()) throw Error('A IA retornou uma resposta vazia. Tente novamente.')
      active.signal.throwIfAborted()
      cancelAnimationFrame(frame); frame = 0; render(true)
      history.push({ role: 'user', content: text }, { role: 'assistant', content: complete.slice(0, 16000) })
      while (history.length > 10) history.splice(0, 2)
      const actions = document.createElement('div'); actions.className = 'message-actions'
      actions.append(window.FimapRenderer.copy(complete, 'Copiar resposta')); assistant.body.append(actions)
      status.textContent = 'Resposta concluída. Pode continuar a conversa.'
    } catch (error) {
      if (id !== generation) return
      cancelAnimationFrame(frame); frame = 0
      if (complete) render(true); else assistant.bubble.textContent = ''
      const interrupted = active.signal.aborted && !timedOut
      const reason = timedOut ? 'A resposta demorou mais que o esperado. Tente novamente.'
        : interrupted ? 'Resposta interrompida por você.' : error.message || 'Não foi possível conectar à IA.'
      const note = document.createElement('p'); note.className = 'message-state'; note.textContent = reason
      assistant.body.append(note)
      const retryButton = document.createElement('button'); retryButton.type = 'button'; retryButton.textContent = 'Tentar novamente'
      retryButton.addEventListener('click', () => { if (!controller) submit(text, true) })
      const actions = document.createElement('div'); actions.className = 'message-actions'; actions.append(retryButton); assistant.body.append(actions)
      status.textContent = interrupted ? 'Você pode enviar outra pergunta.' : reason
    } finally {
      clearTimeout(timer); cancelAnimationFrame(frame)
      if (id === generation) { controller = null; busy(false); input.focus(); scroll() }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); submit(input.value) })
  stop.addEventListener('click', () => controller?.abort())
  $('nova-conversa').addEventListener('click', () => {
    generation++; controller?.abort(); controller = null
    history.length = 0; chat.replaceChildren(); follow = true
    form.reset(); status.textContent = ''; busy(false); resize(); input.focus()
  })
  form.reset(); resize()
})()
