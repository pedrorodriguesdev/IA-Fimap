/*
 * Faz consultas à HG Brasil: cotações específicas e panorama geral do mercado.
 * É usado pelas ferramentas de índices e panorama e como alternativa em algumas cotações.
 * Toda consulta daqui exige o secret HG_BRASIL_API_KEY e acesso ao recurso no fornecedor.
 * A data de um item não é necessariamente a data dos outros itens do panorama.
 */
const { error } = require('../httpClient')
const v = require('../validation')
const { normalize } = require('../financialDataNormalizer')
// Prepara as consultas com o cliente HTTP e as configurações recebidas do Worker.
function createHgBrasil(client, env) {
    // Executada ao receber uma resposta: mesmo com HTTP de sucesso, o corpo pode
    // informar chave inválida ou falta de acesso ao recurso solicitado.
    const validate = data => {
        if (data?.valid_key === false || (data?.metadata?.key_status && data.metadata.key_status !== 'valid')) throw error('AUTENTICACAO')
        if (data?.error || data?.errors) throw error('PLANO_OU_PERMISSAO')
        if (!data || !data.results) throw error('RESPOSTA_INVALIDA')
    }
    // Só pega a chave quando uma consulta for executada; criar o catálogo não a exige.
    function key() { if (!env.HG_BRASIL_API_KEY) throw error('CHAVE_AUSENTE'); return env.HG_BRASIL_API_KEY }
    // Executada para um ativo específico. O prefixo indica o tipo:
    // B3: para ações, CRYPTO: para cripto e INDEXB3:/INDEXNASDAQ: para índices.
    async function cotacao({ ticker }) {
        v.text(ticker, 'ticker', /^(B3:[A-Z][A-Z0-9]{3,9}|FOREX:[A-Z]{6}|CRYPTO:[A-Z0-9]{5,12}|INDEXB3:(IBOV|IFIX)|INDEXNASDAQ:IXIC)$/)
        const result = await client.get('hgbrasil', '/v2/finance/quotes', { tickers: ticker, key: key() }, { validate })
        if (!Array.isArray(result.data.results)) throw error('RESPOSTA_INVALIDA')
        // Confere se o fornecedor devolveu exatamente o ativo pedido e uma cotação.
        const item = result.data.results.find(row => row.ticker === ticker)
        if (!item?.quote || item.error) throw error('DADOS_INDISPONIVEIS')
        return normalize('cotacao_ativo', 'HG Brasil', result, { ativo: item.symbol || ticker, ticker, valor: v.requiredNumber(item.quote.value), moeda: item.currency || null, variacaoPercentual: v.numeric(item.quote.change_percent) }, { dataReferencia: item.quote.updated_at, unidade: item.unit === 'currency' ? item.currency : item.unit || null, maxAgeDays: ticker.startsWith('CRYPTO:') ? 1 : 5, observacoes: ['Dados sujeitos à cobertura, atraso e permissão do plano HG Brasil.'] })
    }
    // Executada quando pedem uma visão geral do mercado em vez de um ativo só.
    // Separa taxas, moedas e índices e mantém ausências como null, sem inventar valores.
    async function panorama() {
        const result = await client.get('hgbrasil', '/finance', { key: key() }, { kind: 'rates', validate })
        const data = result.data.results
        const taxes = Array.isArray(data.taxes) ? data.taxes.at(-1) : null
        return normalize('panorama_mercado', 'HG Brasil', result, {
            taxas: taxes ? { selic: v.numeric(taxes.selic), cdi: v.numeric(taxes.cdi), unidade: '% ao ano', data: taxes.date || null } : null,
            moedas: Object.entries(data.currencies || {}).filter(([key, value]) => /^[A-Z]{3}$/.test(key) && value && typeof value === 'object').slice(0, 20).map(([moeda, row]) => ({ moeda, base: data.currencies.source || null, compra: v.numeric(row.buy), venda: v.numeric(row.sell) })),
            indices: Object.entries(data.stocks || {}).slice(0, 20).map(([indice, row]) => ({ indice, pontos: v.numeric(row.points), variacaoPercentual: v.numeric(row.variation) }))
        }, { observacoes: ['A data das taxas não determina a data de moedas ou índices. Sem data individual, não afirmar atualização em tempo real.'] })
    }
    // O catálogo recebe estas funções e só as chama quando a ferramenta for escolhida.
    return { cotacao, panorama }
}
module.exports = { createHgBrasil }
