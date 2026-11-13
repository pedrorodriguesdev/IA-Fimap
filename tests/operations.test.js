const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { checkLocal, checkLive } = require('../scripts/doctor.cjs')
const { validateAndPublish, publishSecrets } = require('../scripts/configure-ai.cjs')
const { runAi } = require('../src/services/aiProvider')
const account = 'ab'.repeat(16), token = 'token-teste-operacoes'
const health = () => Response.json({ online: true, iaConfigurada: true, model: 'modelo', provedorIA: 'conta-externa' })
const stream = content => new Response(content, { headers: { 'Content-Type': 'text/event-stream' } })

test('diagnóstico distingue dependências ausentes de configuração do site', () => {
  const issues = checkLocal({ read(file, encoding) {
    if (file.includes('node_modules')) throw Error('ausente')
    return fs.readFileSync(file, encoding)
  } })
  assert.ok(issues.some(item => /esbuild.*npm ci/.test(item)))
  assert.ok(issues.every(item => !/token|cota/i.test(item)))
})

test('diagnóstico rejeita dependência diferente do lockfile e Node antigo', () => {
  const issues = checkLocal({ nodeVersion: '22.13.0', read(file, encoding) {
    if (file.includes('node_modules')) return '{"version":"0.0.0"}'
    return fs.readFileSync(file, encoding)
  } })
  assert.ok(issues.some(item => /22.14/.test(item)))
  assert.ok(issues.some(item => /lockfile|package-lock/.test(item)))
})

test('health pronto com autenticação ou cota recusada não passa no diagnóstico real', async () => {
  for (const codigo of ['AI_QUOTA', 'AI_PROVIDER_AUTH']) {
    let calls = 0
    await assert.rejects(checkLive('https://example.test', async () => ++calls === 1 ? health() : Response.json({ codigo, mensagem: token }, { status: 503 })), error => error.message.includes(codigo) && !error.message.includes(token))
    assert.equal(calls, 2)
  }
})

test('diagnóstico exige texto e conclusão explícita do streaming', async () => {
  for (const content of ['data: {"tipo":"trecho","conteudo":"parcial"}\n\n', 'data: {"tipo":"fim"}\n\n']) {
    let calls = 0
    await assert.rejects(checkLive('https://example.test', async () => ++calls === 1 ? health() : stream(content)), /vazia ou interrompida/)
  }
  let calls = 0
  assert.equal((await checkLive('https://example.test', async () => ++calls === 1 ? health() : stream('data: {"tipo":"trecho","conteudo":"OK"}\n\ndata: {"tipo":"fim"}\n\n'))).provider, 'conta-externa')
})

test('troca não publica secrets com token malformado nem com resposta vazia', async () => {
  for (const bad of ['Bearer token', '"token"', 'token com espaco']) {
    await assert.rejects(validateAndPublish(account, bad, { infer: () => assert.fail('não deve inferir'), publish: () => assert.fail('não deve publicar') }), /formato inválido/)
  }
  await assert.rejects(validateAndPublish(account, token, { infer: async () => ({ response: '' }), publish: () => assert.fail('não deve publicar') }), /nenhum secret/)
})

test('autenticação, acesso, cota e token de outra conta impedem substituição dos secrets', async () => {
  const original = global.fetch
  try {
    for (const [status, codigo] of [[401, 'AI_PROVIDER_AUTH'], [403, 'AI_PROVIDER_ACCESS'], [429, 'AI_QUOTA']]) {
      global.fetch = async () => Response.json({ success: false, errors: [{ code: status === 429 ? 4006 : 10000, message: token }] }, { status })
      await assert.rejects(validateAndPublish(account, token, { infer: runAi, publish: () => assert.fail('Credencial recusada não pode ser publicada') }), { code: codigo })
    }
  } finally { global.fetch = original }
})

test('troca só envia os dois secrets juntos depois que o modelo responde', async () => {
  const order = []
  await validateAndPublish(account, token, {
    infer: async (env, model, input) => {
      order.push('validar')
      assert.equal(env.AI_PROVIDER_ACCOUNT_ID, account)
      assert.equal(env.AI_PROVIDER_API_TOKEN, token)
      assert.ok(model.startsWith('@cf/'))
      assert.equal(input.stream, false)
      return { response: 'OK' }
    },
    publish: async secrets => {
      order.push('publicar')
      assert.deepEqual(secrets, { AI_PROVIDER_ACCOUNT_ID: account, AI_PROVIDER_API_TOKEN: token })
    }
  })
  assert.deepEqual(order, ['validar', 'publicar'])
})

test('publicação entrega o par por stdin sem token em argumento, arquivo ou log', () => {
  const logs = []
  publishSecrets({ AI_PROVIDER_ACCOUNT_ID: account, AI_PROVIDER_API_TOKEN: token }, {
    spawn(executable, args, options) {
      assert.equal(executable, process.execPath)
      assert.deepEqual(args.slice(1, 3), ['secret', 'bulk'])
      assert.ok(!args.join(' ').includes(token))
      assert.equal(options.windowsHide, true)
      assert.equal(options.shell, undefined)
      assert.deepEqual(JSON.parse(options.input), { AI_PROVIDER_ACCOUNT_ID: account, AI_PROVIDER_API_TOKEN: token })
      return { status: 0, stdout: token, stderr: token }
    },
    log: value => logs.push(value)
  })
  assert.ok(!JSON.stringify(logs).includes(token))
})

test('falha do publicador não revela saída bruta nem confirma sucesso', () => {
  assert.throws(() => publishSecrets({ AI_PROVIDER_ACCOUNT_ID: account, AI_PROVIDER_API_TOKEN: token }, {
    spawn: () => ({ status: 1, stdout: token, stderr: token }),
    log: () => assert.fail('não pode confirmar sucesso')
  }), error => /confirmar a atualização/.test(error.message) && !error.message.includes(token))
})
