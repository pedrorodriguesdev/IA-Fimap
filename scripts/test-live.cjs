// Usa a IA publicada de verdade e consome a cota de Workers AI.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { parseEvent } = require('../src/services/chatProtocol')
const base = (process.argv[2] || process.env.FIMAP_TEST_URL || 'https://ia-fimap.fimap-agency.workers.dev').replace(/\/+$/, '')
async function chat(messages) {
  const start = Date.now()
  const response = await fetch(`${base}/v1/ia/chat-publico`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal: AbortSignal.timeout(180000) })
  assert.equal(response.status, 200, await (!response.ok ? response.text() : Promise.resolve('')))
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', text = '', doneEvent = false, firstTokenMs
  const processEvent = event => {
    const parsed = parseEvent(event)
    assert.ok(!parsed?.error, parsed?.error)
    if (parsed?.text) { firstTokenMs ??= Date.now() - start; text += parsed.text }
    if (parsed?.done) doneEvent = true
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''
      events.forEach(processEvent)
      if (done) { if (buffer.trim()) processEvent(buffer); break }
    }
  } finally { await reader.cancel().catch(() => {}) }
  assert.equal(doneEvent, true); assert.ok(text.trim().length > 10)
  assert.doesNotMatch(text, /<think>|reasoning_content|secret-do-provedor/)
  return { text, firstTokenMs, totalMs: Date.now() - start }
}
async function run() {
  const results = []
  const health = await fetch(`${base}/health`); assert.equal(health.status, 200); assert.equal((await health.json()).iaConfigurada, true)
  const checks = [
    { name: 'apresentação', messages: [{ role: 'user', content: 'Olá! Em uma frase, diga como pode me ajudar.' }], check: /finan|dinheiro|orçamento|planej|ajud/i },
    { name: 'orçamento', messages: [{ role: 'user', content: 'Recebo R$ 5000 e gasto R$ 3200 por mês. Qual é o valor que sobra? Responda brevemente.' }], check: /1[.,\s]?800|mil e oitocentos/i },
    { name: 'histórico', messages: [{ role: 'user', content: 'Recebo R$ 5000 e gasto R$ 3200 por mês.' }, { role: 'assistant', content: 'Sobram R$ 1800 por mês.' }, { role: 'user', content: 'Se eu separar metade dessa sobra para a reserva, quanto guardo por mês? Seja breve.' }], check: /900|novecentos/i },
    { name: 'câmbio com fonte', messages: [{ role: 'user', content: 'Use consultarCotacaoMoeda para obter USD/BRL. Informe taxa, fonte e data do dado. Se a consulta falhar, explique sem inventar números. Seja breve.' }], check: /Frankfurter|Banco Central|PTAX|fonte|indispon|não foi possível|falh/i }
  ]
  for (const item of checks) {
    if (results.length) await new Promise(resolve => setTimeout(resolve, 5200))
    const result = await chat(item.messages); assert.match(result.text, item.check)
    results.push({ name: item.name, ...result }); console.log(`PASS ${item.name}: primeiro trecho ${result.firstTokenMs} ms, total ${result.totalMs} ms\n${result.text}\n`)
  }
  const privateResponse = await fetch(`${base}/v1/ia/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Oi' }] }) })
  assert.ok([401, 503].includes(privateResponse.status))
  const dir = path.resolve(__dirname, '../artifacts'); await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'live-results.json'), JSON.stringify({ testedAt: new Date().toISOString(), url: base, privateStatus: privateResponse.status, results }, null, 2))
  console.log('PASS: IA real, SSE concluído, respostas esperadas e proteção da rota do back-end.')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
