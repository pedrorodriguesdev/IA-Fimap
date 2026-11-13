// Diagnóstico local; --live também faz uma pergunta real e consome cota.
const fs = require('node:fs')
const path = require('node:path')
const { parseEvent } = require('../src/services/chatProtocol')
const root = path.resolve(__dirname, '..')

function checkLocal({ read = fs.readFileSync, nodeVersion = process.versions.node } = {}) {
  const issues = []
  const [major, minor] = nodeVersion.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 14)) issues.push('Use Node.js 22.14 ou superior.')
  const pkg = JSON.parse(read(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(read(path.join(root, 'package-lock.json'), 'utf8'))
  for (const name of Object.keys(pkg.devDependencies)) {
    try {
      const installed = JSON.parse(read(path.join(root, 'node_modules', name, 'package.json'), 'utf8'))
      if (installed.version !== lock.packages['node_modules/' + name]?.version) issues.push(name + ': versão diferente do package-lock.json; execute npm ci.')
    } catch { issues.push(name + ': ausente; execute npm ci nesta cópia do projeto.') }
  }
  return issues
}

async function checkLive(base, fetchImpl = fetch) {
  const url = new URL(base)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw Error('Use HTTPS ou um servidor local.')
  if (url.pathname !== '/' || url.search || url.hash) throw Error('Informe somente a URL base do site.')
  const origin = url.origin
  const signal = AbortSignal.timeout(60000)
  const healthResponse = await fetchImpl(origin + '/health', { signal, redirect: 'error' })
  const health = await healthResponse.json()
  if (!healthResponse.ok || !health.online || !health.iaConfigurada) throw Error('A configuração do Worker está ausente ou incompleta.')
  const response = await fetchImpl(origin + '/v1/ia/chat-publico', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Responda apenas: OK.' }] }),
    signal, redirect: 'error'
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const hints = {
      AI_QUOTA: 'Cota esgotada na conta provedora. Consulte o uso no Cloudflare; instalar dependências não renova a cota.',
      AI_PROVIDER_AUTH: 'Token recusado. Confira token, permissões e Account ID da mesma conta; use npm run ai:configure.',
      AI_PROVIDER_ACCESS: 'A conta provedora não tem acesso ao modelo.',
      AI_CONFIGURATION: 'Configuração da IA incompleta ou malformada.'
    }
    const code = Object.hasOwn(hints, data.codigo) ? data.codigo : 'HTTP_' + response.status
    throw Error(code + ': ' + (hints[code] || 'Serviço indisponível; tente após o prazo informado em Retry-After.'))
  }
  if (!response.headers.get('Content-Type')?.includes('text/event-stream') || !response.body) throw Error('A IA não retornou streaming.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', text = '', complete = false
  const consume = event => {
    const data = parseEvent(event)
    if (data?.error) throw Error(data.error)
    if (data?.text) text += data.text
    if (data?.done) complete = true
  }
  try {
    while (!complete) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''
      for (const event of events) { consume(event); if (complete) break }
      if (done) { if (!complete && buffer.trim()) consume(buffer); break }
    }
  } finally { await reader.cancel().catch(() => {}) }
  if (!complete || !text.trim()) throw Error('A IA retornou uma resposta vazia ou interrompida.')
  return { model: health.model, provider: health.provedorIA }
}

async function main() {
  const issues = checkLocal()
  if (issues.length) throw Error(issues.join('\n'))
  console.log('OK: Node.js e dependências locais conferem com o lockfile. Isso não verifica o site publicado.')
  if (process.argv.includes('--live')) {
    const selected = process.argv.find(value => /^https?:\/\//.test(value)) || process.env.FIMAP_TEST_URL || 'https://ia-fimap.fimap-agency.workers.dev'
    const result = await checkLive(selected)
    console.log('OK: o site respondeu a uma pergunta real e concluiu o streaming. Provedor: ' + result.provider + '; modelo: ' + result.model)
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { checkLocal, checkLive }
