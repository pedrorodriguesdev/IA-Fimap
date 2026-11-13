// Valida o novo par antes de substituir os dois secrets em uma única operação.
// O token entra por prompt oculto e pelo stdin do Wrangler; não vai a arquivo ou argumento.
const { createInterface } = require('node:readline/promises')
const { Writable } = require('node:stream')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { runAi, isAiConfigured, publicFailure } = require('../src/services/aiProvider')
const { MODEL } = require('../src/ai-model')
const root = path.resolve(__dirname, '..')

async function validateAndPublish(account, token, { infer = runAi, publish = publishSecrets } = {}) {
  const secrets = { AI_PROVIDER_ACCOUNT_ID: account.trim(), AI_PROVIDER_API_TOKEN: token.trim() }
  if (!isAiConfigured(secrets)) throw Error('Account ID ou token em formato inválido. Cole somente os valores, sem Bearer ou aspas.')
  const result = await infer(secrets, MODEL, {
    messages: [{ role: 'user', content: 'Responda apenas: OK.' }], stream: false,
    max_completion_tokens: 64, temperature: 0, chat_template_kwargs: { enable_thinking: false }
  }, AbortSignal.timeout(30000))
  const answer = result?.response ?? result?.choices?.[0]?.message?.content
  if (typeof answer !== 'string' || !answer.trim()) throw Error('A conta não gerou uma resposta válida; nenhum secret foi alterado.')
  await publish(secrets)
}

function publishSecrets(secrets, { spawn = spawnSync, log = console.log } = {}) {
  const packageFile = require.resolve('wrangler/package.json')
  const cli = path.resolve(path.dirname(packageFile), require(packageFile).bin.wrangler)
  const child = spawn(process.execPath, [cli, 'secret', 'bulk', '--config', path.join(root, 'wrangler.jsonc')], {
    cwd: root, input: JSON.stringify(secrets), encoding: 'utf8', windowsHide: true, timeout: 120000
  })
  // Não imprimir a saída bruta: mensagens de terceiros podem conter credenciais.
  if (child.error || child.status !== 0) throw Error('Não foi possível confirmar a atualização. Confira wrangler whoami e os secrets no painel antes de repetir.')
  log('Os dois secrets foram enviados juntos ao Worker ia-fimap.')
}

async function main() {
  const issues = require('./doctor.cjs').checkLocal()
  if (issues.length) throw Error(issues.join('\n'))
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Execute npm run ai:configure em um terminal interativo.')
  console.log('Validação real do novo provedor: consome uma pequena quantidade de cota. O Wrangler deve estar conectado à conta que hospeda o site.')
  let hidden = false
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback() } })
  const prompt = createInterface({ input: process.stdin, output, terminal: true })
  let token
  try {
    const account = await prompt.question('Account ID da conta provedora: ')
    process.stdout.write('API token da mesma conta (entrada oculta): ')
    hidden = true
    token = await prompt.question('')
    process.stdout.write('\n')
    prompt.close()
    console.log('Testando acesso ao modelo antes de alterar os secrets…')
    await validateAndPublish(account, token)
    console.log('Execute npm run doctor:live para verificar a versão publicada.')
  } finally { hidden = false; token = undefined; prompt.close() }
}
if (require.main === module) main().catch(error => {
  const safe = error.aiProviderError ? publicFailure(error) : null
  console.error(safe ? safe.code + ': ' + safe.message + ' Os secrets não foram alterados.' : error.message)
  process.exitCode = 1
})
module.exports = { validateAndPublish, publishSecrets }
