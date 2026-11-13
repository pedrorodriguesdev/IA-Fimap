const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { runAi, isAiConfigured, publicFailure } = require('../src/services/aiProvider')
const account = 'ab'.repeat(16), token = 'token-segunda-conta'
const model = '@cf/google/gemma-4-26b-a4b-it'
const json = (body, status = 200) => Response.json(body, { status })
const external = extra => ({ AI_PROVIDER_ACCOUNT_ID: account, AI_PROVIDER_API_TOKEN: token, AI: { run() { assert.fail('Não pode consumir a conta do Worker.') } }, ...extra })
const input = { messages: [{ role: 'user', content: 'Olá' }], stream: false }
const sse = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"Banco consultado."}\n\ndata: [DONE]\n\n')); c.close() } })
let originalFetch
beforeEach(() => { originalFetch = global.fetch })
afterEach(() => { global.fetch = originalFetch })

test('conta externa recebe o planejamento e preserva o resultado de chamadas de ferramenta', async () => {
  const result = { choices: [{ message: { tool_calls: [{ function: { name: 'consultarCDI', arguments: '{}' } }] } }] }
  global.fetch = async (url, options) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.deepEqual(JSON.parse(options.body), input)
    return json({ success: true, result })
  }
  assert.deepEqual(await runAi(external(), model, input), result)
})

test('stream externo é entregue imediatamente e pode ser cancelado', async () => {
  let cancelled = false
  global.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"response":"Olá"}\n\n')) }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'text/event-stream' } })
  const stream = await runAi(external(), model, { ...input, stream: true })
  const reader = stream.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /Olá/)
  await reader.cancel()
  assert.equal(cancelled, true)
})

test('cancelamento da requisição também cancela a chamada REST da conta externa', async () => {
  const abort = new AbortController()
  let upstreamSignal
  global.fetch = async (_url, options) => {
    upstreamSignal = options.signal
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const result = runAi(external(), model, input, abort.signal)
  abort.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(upstreamSignal.aborted, true)
})

test('credenciais externas incompletas ou inválidas não usam a conta do Worker', async () => {
  global.fetch = () => assert.fail('Não deveria fazer um pedido com configuração incompleta.')
  for (const extra of [
    { AI_PROVIDER_ACCOUNT_ID: undefined }, { AI_PROVIDER_API_TOKEN: undefined },
    { AI_PROVIDER_ACCOUNT_ID: '' }, { AI_PROVIDER_API_TOKEN: '' },
    { AI_PROVIDER_ACCOUNT_ID: 'https://outra.test' }, { AI_PROVIDER_API_TOKEN: 'token\ninválido' },
    { AI_PROVIDER_API_TOKEN: 'Bearer token' }, { AI_PROVIDER_API_TOKEN: '"token"' },
    { AI_PROVIDER_API_TOKEN: "'token'" }, { AI_PROVIDER_API_TOKEN: 'token com espacos' },
    { AI_PROVIDER_API_TOKEN: 'token\\' }
  ]) {
    const env = external(extra)
    assert.equal(isAiConfigured(env), false)
    await assert.rejects(runAi(env, model, input), { code: 'AI_CONFIGURATION' })
  }
})

test('binding só é usado quando nenhuma credencial externa foi declarada', async () => {
  let calls = 0
  global.fetch = () => assert.fail('Não deveria consultar a API REST.')
  const env = { AI: { run: async (selectedModel, received) => { calls++; assert.equal(selectedModel, model); assert.equal(received, input); return { response: 'Olá' } } } }
  assert.deepEqual(await runAi(env, model, input), { response: 'Olá' })
  assert.equal(calls, 1)
})

test('falhas REST não expõem o corpo do provedor nem acionam a conta do Worker', async () => {
  for (const [status, code] of [[401, 'AI_PROVIDER_AUTH'], [403, 'AI_PROVIDER_ACCESS'], [429, 'AI_RATE_LIMIT'], [503, 'AI_UNAVAILABLE'], [302, 'AI_PROVIDER_REDIRECT']]) {
    let calls = 0
    global.fetch = async () => { calls++; return json({ success: false, errors: [{ message: token }] }, status) }
    await assert.rejects(runAi(external(), model, input), error => {
      const safe = publicFailure(error)
      assert.equal(safe.code, code)
      assert.ok(!JSON.stringify(safe).includes(token))
      return true
    })
    assert.equal(calls, 1)
  }
})

test('cota diária retorna mensagem clara e espera até a renovação, inclusive com HTTP 200', async () => {
  for (const status of [429, 200]) {
    global.fetch = async () => json({ success: false, errors: [{ code: 4006, message: 'daily free allocation' }] }, status)
    await assert.rejects(runAi(external(), model, input), error => {
      const safe = publicFailure(error)
      assert.equal(safe.code, 'AI_QUOTA')
      assert.equal(safe.status, 429)
      assert.ok(safe.retryAfter > 0 && safe.retryAfter <= 86400)
      return true
    })
  }
})

test('respostas vazias, JSON malformado e falso streaming são recusados', async () => {
  for (const [stream, makeResponse] of [[false, () => new Response('inválido')], [false, () => json({ success: true, result: null })], [true, () => json({ success: true, result: { response: 'Não é um stream.' } })]]) {
    global.fetch = async () => makeResponse()
    await assert.rejects(runAi(external(), model, { ...input, stream }), { code: 'AI_INVALID_RESPONSE' })
  }
})

async function createWorker(fetchImpl) {
  const built = await require('esbuild').build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'cjs', platform: 'neutral' })
  const logs = []
  const context = { module: { exports: {} }, Request, Response, Headers, URL, ReadableStream, TextEncoder, TextDecoder, Date, Map, AbortSignal, setTimeout, clearTimeout, fetch: fetchImpl, console: { info() {}, error(value) { logs.push(value) } } }
  require('node:vm').runInNewContext(built.outputFiles[0].text, context)
  return { worker: context.module.exports.default, logs }
}
const request = () => new Request('https://test/v1/ia/chat-publico', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Consulte o banco 1.' }] }) })
const settings = () => external({ FINANCIAL_TOOLS_ENABLED: 'true', CHAT_RATE_LIMITER: { limit: async () => ({ success: true }) } })

test('Worker usa a conta externa no planejamento, consulta de API e resposta final em SSE', async () => {
  let plans = 0, streams = 0, queries = 0
  const { worker } = await createWorker(async (url, options) => {
    if (url.startsWith('https://brasilapi.com.br/')) {
      queries++
      assert.equal(options.headers.Authorization, undefined)
      return json({ code: 1, name: 'Banco de teste' })
    }
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`)
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    const body = JSON.parse(options.body)
    if (body.stream) {
      streams++
      assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('Banco de teste')))
      return new Response(sse(), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (plans++ === 0) return json({ success: true, result: { choices: [{ message: { tool_calls: [{ function: { name: 'consultarInstituicaoFinanceira', arguments: '{"codigo":1}' } }] } }] } })
    return json({ success: true, result: { response: 'Dados recebidos.' } })
  })
  const env = settings()
  const health = await (await worker.fetch(new Request('https://test/health'), env)).json()
  assert.equal(health.iaConfigurada, true)
  assert.equal(health.provedorIA, 'conta-externa')
  assert.equal(health.configuracaoIA, 'pronta')
  assert.equal(health.verificacaoIA, 'somente-formato')
  for (const [extra, code] of [[{ AI_PROVIDER_ACCOUNT_ID: 'email@teste.test' }, 'id-conta-invalido'], [{ AI_PROVIDER_API_TOKEN: '' }, 'token-invalido']]) {
    const bad = { ...env, ...extra }
    const health = await (await worker.fetch(new Request('https://test/health'), bad)).json()
    assert.equal(health.iaConfigurada, false)
    assert.equal(health.configuracaoIA, code)
    assert.ok(!JSON.stringify(health).includes(token))
    assert.equal((await worker.fetch(request(), bad)).status, 503)
  }
  assert.equal(plans, 0); assert.equal(streams, 0); assert.equal(queries, 0)
  const response = await worker.fetch(request(), env)
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /Banco consultado/)
  assert.match(text, /"tipo":"fim"/)
  assert.equal(plans, 2); assert.equal(streams, 1); assert.equal(queries, 1)
})

test('cota esgotada encerra o planejamento sem repetir inferência ou usar a conta Fimap', async () => {
  let calls = 0
  const { worker, logs } = await createWorker(async () => { calls++; return json({ success: false, errors: [{ code: 4006, message: token }] }, 429) })
  const response = await worker.fetch(request(), settings())
  assert.equal(response.status, 429)
  assert.equal((await response.json()).codigo, 'AI_QUOTA')
  assert.ok(Number(response.headers.get('Retry-After')) > 0)
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(logs).includes(token))
})
