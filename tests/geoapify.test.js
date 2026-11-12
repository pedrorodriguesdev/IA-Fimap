const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createRegistry } = require('../src/services/financial/financialToolRegistry')
const { prepareFinancialMessages } = require('../src/services/financial/financialChatOrchestrator')

const key = 'geo-chave-de-teste'
const feature = (properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-46.65, -23.56] }, properties: { formatted: 'Avenida Paulista, São Paulo, Brasil', city: 'São Paulo', country: 'Brasil', ...properties } })
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers })
const env = () => ({ GEOAPIFY_API_KEY: key, FINANCIAL_HTTP_RETRIES: '0' })
const nearby = { categoria: 'supermercado', latitude: -23.56, longitude: -46.65 }

test('Geoapify localiza endereço com autenticação, sem cache ou metadados privados no retorno', async () => {
    let requests = 0
    const tools = createRegistry(env(), { fetchImpl: async (input, options) => {
        requests++
        const url = new URL(input)
        assert.equal(url.origin, 'https://api.geoapify.com')
        assert.equal(url.pathname, '/v1/geocode/search')
        assert.equal(url.searchParams.get('apiKey'), key)
        assert.equal(url.searchParams.get('text'), 'Avenida Paulista, São Paulo')
        assert.equal(options.redirect, 'manual')
        return json({ features: [feature()], private_metadata: { key } })
    } })
    for (let i = 0; i < 2; i++) {
        const result = await tools.execute('localizarEndereco', { endereco: 'Avenida Paulista, São Paulo' })
        assert.equal(result.dados[0].latitude, -23.56)
        assert.equal(result.dados[0].longitude, -46.65)
        assert.equal(result.fonte, 'Geoapify / OpenStreetMap')
        assert.equal(result.cache, false)
        assert.equal(result.dataReferencia, null)
        assert.equal(result.desatualizado, null)
        assert.ok(!JSON.stringify(result).includes(key))
    }
    assert.equal(requests, 2)
})

test('Geoapify busca estabelecimentos usando longitude/latitude na ordem correta', async () => {
    const tools = createRegistry(env(), { fetchImpl: async input => {
        const url = new URL(input)
        assert.equal(url.pathname, '/v2/places')
        assert.equal(url.searchParams.get('categories'), 'commercial.supermarket')
        assert.equal(url.searchParams.get('filter'), 'circle:-46.65,-23.56,2000')
        assert.equal(url.searchParams.get('bias'), 'proximity:-46.65,-23.56')
        return json({ features: [feature({ name: 'Mercado', distance: 120, categories: ['commercial.supermarket'] })] })
    } })
    const result = await tools.execute('buscarLocaisProximos', nearby)
    assert.equal(result.dados.locais[0].nome, 'Mercado')
    assert.equal(result.dados.locais[0].distanciaMetros, 120)
    assert.ok(result.observacoes.some(o => o.includes('não informa preços')))
})

test('Geoapify rejeita chave ausente, dados inválidos e parâmetros de URL sem fazer consultas', async () => {
    let requests = 0
    const options = { fetchImpl: async () => { requests++; throw Error('Não deveria chamar a rede') } }
    await assert.rejects(createRegistry({}, options).execute('localizarEndereco', { endereco: 'São Paulo' }), { code: 'CHAVE_AUSENTE' })
    const tools = createRegistry(env(), options)
    for (const args of [{ ...nearby, latitude: 91 }, { ...nearby, longitude: -181 }, { ...nearby, limite: 11 }, { ...nearby, raioMetros: 20001 }, { ...nearby, categoria: 'inexistente' }, { ...nearby, url: 'http://127.0.0.1' }]) {
        await assert.rejects(tools.execute('buscarLocaisProximos', args))
    }
    await assert.rejects(tools.execute('localizarEndereco', { endereco: '   ' }), { code: 'PARAMETRO_INVALIDO:endereco' })
    await assert.rejects(tools.execute('localizarEndereco', { endereco: 'x'.repeat(301) }), { code: 'ARGUMENTO_GRANDE' })
    assert.equal(requests, 0)
})

test('Geoapify mantém busca vazia como vazia e recusa coordenadas ou estruturas malformadas', async () => {
    const empty = createRegistry(env(), { fetchImpl: async () => json({ features: [] }) })
    assert.deepEqual((await empty.execute('buscarLocaisProximos', nearby)).dados.locais, [])
    for (const body of [{}, { features: {} }, { features: [{ properties: {}, geometry: { type: 'Point', coordinates: [181, 0] } }] }]) {
        const tools = createRegistry(env(), { fetchImpl: async () => json(body) })
        await assert.rejects(tools.execute('localizarEndereco', { endereco: 'São Paulo' }), { code: 'RESPOSTA_INVALIDA' })
    }
})

test('Geoapify trata erros de autenticação, plano, cota e redirecionamento sem expor a chave', async () => {
    for (const [status, code] of [[401, 'AUTENTICACAO'], [403, 'PLANO_OU_PERMISSAO'], [429, 'COTA_EXCEDIDA'], [503, 'PROVEDOR_INDISPONIVEL'], [302, 'REDIRECIONAMENTO_NAO_PERMITIDO']]) {
        let requests = 0
        const tools = createRegistry(env(), { fetchImpl: async () => { requests++; return json({ message: key }, status, { Location: 'https://example.com' }) } })
        await assert.rejects(tools.execute('localizarEndereco', { endereco: 'São Paulo' }), cause => cause.code === code && !cause.message.includes(key))
        assert.equal(requests, 1)
    }
})

test('orchestrator entrega coordenadas reais à próxima rodada e devolve locais à IA sem credenciais', async () => {
    let rounds = 0
    const plan = (name, args) => ({ tool_calls: [{ id: 'geo-test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    const result = await prepareFinancialMessages([{ role: 'user', content: 'Supermercados próximos à Avenida Paulista, São Paulo' }], env(), async inputs => {
        rounds++
        assert.ok(inputs.tools.some(t => t.function.name === 'localizarEndereco'))
        assert.ok(inputs.tools.some(t => t.function.name === 'buscarLocaisProximos'))
        if (rounds === 1) return plan('localizarEndereco', { endereco: 'Avenida Paulista, São Paulo' })
        const data = JSON.parse(inputs.messages.filter(m => m.role === 'tool').at(-1).content)
        if (rounds === 2) {
            assert.equal(data.resultado.dados[0].longitude, nearby.longitude)
            return plan('buscarLocaisProximos', nearby)
        }
        assert.equal(data.resultado.dados.locais[0].nome, 'Mercado')
        return { tool_calls: [] }
    }, { fetchImpl: async input => json({ features: [feature(new URL(input).pathname === '/v2/places' ? { name: 'Mercado' } : {})] }) })
    assert.equal(result.filter(m => m.role === 'tool').length, 2)
    assert.ok(!JSON.stringify(result).includes(key))
})
