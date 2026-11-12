/*
 * Conecta a IA ao Geoapify para descobrir endereços e procurar locais próximos.
 * Primeiro localizarEndereco encontra coordenadas de um lugar informado pelo usuário.
 * Depois buscarLocaisProximos usa coordenadas conhecidas para consultar estabelecimentos.
 * A chave fica no servidor. Endereços e coordenadas não entram no cache compartilhado.
 * Os resultados são referências cadastrais; não informam preços nem garantem loja aberta.
 */
const { error } = require('../httpClient')
const v = require('../validation')
const { normalize } = require('../financialDataNormalizer')

// Traduz as opções que a IA pode pedir para as categorias oficiais do fornecedor.
// Só estas categorias são aceitas: a IA não escolhe URLs nem parâmetros de autenticação.
const CATEGORIES = Object.freeze({
    supermercado: 'commercial.supermarket',
    restaurante: 'catering.restaurant',
    cafe: 'catering.cafe',
    banco: 'service.financial.bank',
    caixa_eletronico: 'service.financial.atm',
    casa_de_cambio: 'service.financial.bureau_de_change',
})

function createGeoapify(client, env) {
    // Confere a chave na hora da consulta. Um secret ausente não impede o uso
    // das outras ferramentas financeiras e não é substituído por uma chave fictícia.
    function key() {
        const value = typeof env.GEOAPIFY_API_KEY === 'string' ? env.GEOAPIFY_API_KEY.trim() : ''
        if (!value) throw error('CHAVE_AUSENTE')
        if (/\s/.test(value)) throw error('AUTENTICACAO')
        return value
    }
    const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : null

    // Lê só os campos necessários. Não devolve a resposta bruta, metadados internos
    // ou links do fornecedor que possam conter credenciais.
    function places(response, limit) {
        if (!Array.isArray(response.data?.features)) throw error('RESPOSTA_INVALIDA')
        return response.data.features.slice(0, limit).map(feature => {
            const p = feature?.properties
            const coordinates = feature?.geometry?.coordinates
            if (!p || feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates)
                || typeof coordinates[0] !== 'number' || !Number.isFinite(coordinates[0]) || Math.abs(coordinates[0]) > 180
                || typeof coordinates[1] !== 'number' || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[1]) > 90) throw error('RESPOSTA_INVALIDA')
            const distance = v.numeric(p.distance)
            return {
                nome: text(p.name), endereco: text(p.formatted, 500),
                cidade: text(p.city), estado: text(p.state), pais: text(p.country), codigoPostal: text(p.postcode, 30),
                latitude: coordinates[1], longitude: coordinates[0],
                distanciaMetros: distance !== null && distance >= 0 ? distance : null,
                categorias: Array.isArray(p.categories) ? p.categories.filter(c => typeof c === 'string').slice(0, 12).map(c => c.slice(0, 100)) : [],
            }
        })
    }
    const observations = [
        'Fonte: Geoapify / OpenStreetMap. Dados cadastrais podem estar incompletos ou desatualizados.',
        'Proximidade não informa preços, avaliações ou funcionamento atual. Não afirmar que um local é mais barato ou está aberto.',
    ]

    // Executada quando a IA precisa transformar um endereço ou cidade em coordenadas.
    // Não descobre a localização do usuário: o texto precisa vir da conversa.
    async function localizar({ endereco, limite = 3 }) {
        if (typeof endereco !== 'string' || !endereco.trim() || endereco.length > 300) throw error('PARAMETRO_INVALIDO:endereco')
        v.integer(limite, 'limite', 1, 5)
        const response = await client.get('geoapify', '/v1/geocode/search', {
            text: endereco.trim(), lang: 'pt', limit: limite, apiKey: key(),
        }, { ttl: 0 })
        return normalize('localizacao_endereco', 'Geoapify / OpenStreetMap', response, places(response, limite), { observacoes: observations })
    }

    // Executada depois que as coordenadas forem informadas ou obtidas de localizar.
    // O raio é em metros, limitado a 20 km; a lista tem até dez locais, ordenados por proximidade.
    async function proximos({ categoria, latitude, longitude, raioMetros = 2000, limite = 5 }) {
        if (!Object.hasOwn(CATEGORIES, categoria)) throw error('PARAMETRO_INVALIDO:categoria')
        v.number(latitude, 'latitude', -90, 90)
        v.number(longitude, 'longitude', -180, 180)
        v.integer(raioMetros, 'raioMetros', 100, 20000)
        v.integer(limite, 'limite', 1, 10)
        const response = await client.get('geoapify', '/v2/places', {
            categories: CATEGORIES[categoria], filter: `circle:${longitude},${latitude},${raioMetros}`,
            bias: `proximity:${longitude},${latitude}`, lang: 'pt', limit: limite, apiKey: key(),
        }, { ttl: 0 })
        return normalize('locais_proximos', 'Geoapify / OpenStreetMap', response, {
            categoria, centro: { latitude, longitude }, raioMetros, locais: places(response, limite),
        }, { observacoes: observations })
    }
    return { localizar, proximos }
}
module.exports = { createGeoapify, CATEGORIES }
