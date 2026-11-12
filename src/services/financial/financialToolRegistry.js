/*
 * Este arquivo é o catálogo e a porta de entrada das ferramentas da IA.
 * Cada add abaixo liga um nome a uma descrição, aos dados aceitos e à função que executa.
 * O orchestrator mostra essas descrições à IA antes de ela escolher uma ferramenta.
 * Quando a IA escolhe, execute confere o pedido e chama a função cadastrada.
 * Cadastrar uma ferramenta não faz uma consulta: a API só é chamada na execução.
 * Este arquivo não grava consultas em disco nem faz a IA aprender permanentemente.
 */
const { createClient, error } = require('./httpClient')
const v = require('./validation')
const { createBancoCentral, SERIES } = require('./providers/bancoCentral')
const { createBrasilApi } = require('./providers/brasilApi')
const { createBrapi } = require('./providers/brapi')
const { createHgBrasil } = require('./providers/hgBrasil')
const { createFrankfurter } = require('./providers/frankfurter')
const { createGeoapify, CATEGORIES } = require('./providers/geoapify')
const { createSelector } = require('./financialProviderSelector')
const calc = require('./calculations')
const { createTavilySearch } = require('../webSearch/tavilySearchService')
// Ajudantes para descrever os campos que a IA pode enviar:
// str = texto, num = número, int = número inteiro, choice = uma das opções listadas.
const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const int = description => ({ type: 'integer', description })
const choice = values => ({ type: 'string', enum: values })
const stockArgs = { simbolo: str('Ticker B3, por exemplo PETR4 ou HGLG11'), inicio: str('Opcional YYYY-MM-DD, junto de fim; máximo 366 dias'), fim: str('YYYY-MM-DD') }
// Monta o catálogo para uma pergunta. env fornece configurações e secrets;
// options permite passar cancelamento e substituir a rede nos testes.
function createRegistry(env = {}, options = {}) {
    // O cliente HTTP cuida de rede, cache e limites. Cada provider sabe os endereços
    // e o formato do seu fornecedor. Criá-los aqui ainda não envia pedidos à internet.
    const client = createClient(env, options)
    const geo = createGeoapify(client, env)
    const bcb = createBancoCentral(client), brasil = createBrasilApi(client), brapi = createBrapi(client, env), hg = createHgBrasil(client, env), fx = createFrankfurter(client)
    // Algumas ferramentas têm mais de uma fonte. O seletor tenta as fontes permitidas
    // na ordem configurada, sem trocar o significado do dado solicitado.
    const select = createSelector(env)
    const tavily = createTavilySearch(env, { fetchImpl: options.fetchImpl, signal: options.signal, now: options.now })
    // Esta tabela existe na memória: nome da ferramenta -> descrição e execução.
    const registry = Object.create(null)
    // description explica quando usar; properties descreve os campos;
    // required indica os obrigatórios; execute é a função que faz o trabalho de verdade.
    function add(name, description, properties, required, execute) {
        registry[name] = { definition: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }, execute }
    }
    // Use para descobrir coordenadas de uma cidade ou endereço informado pelo usuário.
    add('localizarEndereco', 'Localiza endereço ou cidade pelo Geoapify. Use antes de buscar locais se não tiver coordenadas reais. Se houver ambiguidade, peça confirmação. Não descobre a localização do usuário.', { endereco: { ...str('Endereço ou cidade informado na conversa, com cidade/país quando conhecidos'), maxLength: 300 }, limite: int('Quantidade de alternativas, 1 a 5; padrão 3') }, ['endereco'], geo.localizar)
    // Use com coordenadas conhecidas para encontrar estabelecimentos próximos, sem inventar preços.
    add('buscarLocaisProximos', 'Busca supermercados, restaurantes, cafés, bancos, caixas eletrônicos ou casas de câmbio pelo Geoapify. Use coordenadas fornecidas ou de localizarEndereco; não invente localização. Não informa preços, avaliações nem abertura atual.', { categoria: choice(Object.keys(CATEGORIES)), latitude: num('Latitude real, -90 a 90'), longitude: num('Longitude real, -180 a 180'), raioMetros: int('Raio de 100 a 20000 metros; padrão 2000'), limite: int('Quantidade de locais, 1 a 10; padrão 5') }, ['categoria', 'latitude', 'longitude'], geo.proximos)
    // Use para saber a meta Selic: consulta a série 432 do Banco Central.
    add('consultarTaxaSelic', 'Meta Selic oficial em % ao ano (SGS 432). Não é Selic efetiva diária.', {}, [], () => bcb.serie({ codigo: 432 }))
    // Use para buscar o CDI diário oficial; o número retornado é por dia.
    add('consultarCDI', 'CDI oficial diário em % ao dia (SGS 12). Nunca tratar como anual.', {}, [], () => bcb.serie({ codigo: 12 }))
    // Use para consultar IPCA ou IGP-M do mês, sem confundir com o acumulado anual.
    add('consultarInflacao', 'Variação mensal oficial de IPCA ou IGP-M; não é acumulado em 12 meses.', { indice: choice(['IPCA', 'IGPM']) }, ['indice'], a => bcb.serie({ codigo: a.indice === 'IPCA' ? 433 : 189 }))
    // Use para outra série do Banco Central que esteja na lista permitida SERIES.
    add('consultarSerieEconomica', 'Série SGS permitida. Metadados: ' + JSON.stringify(SERIES), { codigo: int('Código SGS permitido'), inicio: str('YYYY-MM-DD'), fim: str('YYYY-MM-DD') }, ['codigo'], bcb.serie)
    // Use para listar taxas da BrasilAPI; a unidade e a data podem precisar de confirmação.
    add('consultarTaxasDisponiveis', 'Lista de taxas BrasilAPI; unidade e data podem estar ausentes. Não usar em cálculos sem confirmar unidade.', { sigla: str('Opcional: nome exato da taxa presente na lista') }, [], brasil.taxas)
    // Use para preço de ação, FII ou ETF. Tenta brapi e pode usar HG Brasil como alternativa.
    add('consultarCotacaoAcao', 'Preço de ação, FII ou ETF brasileiro. Seleção brapi e HG conforme configuração. Sem garantia de tempo real.', { simbolo: stockArgs.simbolo }, ['simbolo'], a => select('acoes', { brapi: () => brapi.acao(a), hgbrasil: () => hg.cotacao({ ticker: 'B3:' + a.simbolo }) }))
    // Use para preços passados de uma ação; consulta o histórico na brapi.
    add('consultarHistoricoAcao', 'Histórico diário B3; até 260 pontos e período de 366 dias. Exige chave/plano brapi.', stockArgs, ['simbolo'], a => brapi.acao({ ...a, recurso: 'historical' }))
    // Use para consultar pagamentos de proventos de uma ação pela brapi.
    add('consultarDividendos', 'Proventos em dinheiro B3; até 60 eventos. Exige chave/plano brapi.', stockArgs, ['simbolo'], a => brapi.acao({ ...a, recurso: 'dividends' }))
    // Use para indicadores e demonstrativos de uma empresa, conforme acesso na brapi.
    add('consultarFundamentosEmpresa', 'Indicadores numéricos ou demonstrativos B3. Campos indisponíveis permanecem null. Exige chave/plano brapi.', { simbolo: stockArgs.simbolo, recurso: choice(['statistics', 'financial-data', 'balance-sheet', 'income-statement']) }, ['simbolo', 'recurso'], brapi.acao)
    // Use para câmbio diário, como USD/BRL, ou seu histórico pela Frankfurter.
    add('consultarCotacaoMoeda', 'Câmbio de referência diário Frankfurter, incluindo históricos. Não é PTAX nem oferta ao consumidor.', { base: str('ISO, como USD'), destino: str('ISO, como BRL'), data: str('Data opcional YYYY-MM-DD'), inicio: str('Início YYYY-MM-DD, junto de fim'), fim: str('Fim YYYY-MM-DD, máximo 366 dias') }, ['base', 'destino'], fx.cambio)
    // Use quando o pedido for PTAX de uma data: Banco Central primeiro, BrasilAPI como alternativa.
    add('consultarPTAX', 'Boletim oficial de câmbio por moeda/data. Fallback BrasilAPI preserva conceito de boletim. Pode faltar em feriados.', { moeda: str('ISO, como USD'), data: str('YYYY-MM-DD, obrigatório') }, ['moeda', 'data'], a => select('ptax', { bcb: () => bcb.ptax(a), brasilapi: () => brasil.cambio(a) }))
    // Use para preço de cripto. Tenta brapi; a alternativa HG Brasil só entra para valores em reais.
    add('consultarCriptomoeda', 'Cotação de criptomoeda. brapi preferencial; HG complementar apenas BRL. Depende de chave/plano.', { simbolo: str('BTC, ETH etc.'), moeda: str('ISO da cotação; padrão BRL') }, ['simbolo'], a => select('cripto', { brapi: () => brapi.cripto(a), ...(a.moeda && a.moeda !== 'BRL' ? {} : { hgbrasil: () => hg.cotacao({ ticker: 'CRYPTO:' + a.simbolo + 'BRL' }) }) }))
    // Use para IBOV, IFIX ou Nasdaq; depende da cobertura e do plano HG Brasil.
    add('consultarIndices', 'Índice via HG Brasil, sujeito à chave e plano.', { ticker: choice(['INDEXB3:IBOV', 'INDEXB3:IFIX', 'INDEXNASDAQ:IXIC']) }, ['ticker'], hg.cotacao)
    // Use para uma visão geral de taxas, moedas e índices pela HG Brasil.
    add('consultarPanoramaMercado', 'Visão geral HG Brasil; não presumir data de atualização igual para todos os campos.', {}, [], hg.panorama)
    // Use para procurar páginas e notícias pela Tavily; não substitui a API de cotação.
    add('pesquisarWeb', 'Pesquisa páginas públicas na web para notícias e contexto. Para cotações exatas, use as ferramentas financeiras específicas.', { query: { type: 'string', description: 'Consulta curta, até 400 caracteres', maxLength: 400 }, topic: choice(['general', 'news', 'finance']) }, ['query'], tavily.search)
    // Use para identificar um banco pelo código COMPE ou consultar a lista de bancos.
    add('consultarInstituicaoFinanceira', 'Banco por código COMPE ou lista de instituições, via BrasilAPI.', { codigo: int('Código COMPE opcional, 0 a 999') }, [], brasil.bancos)
    // Use para listar moedas, participantes Pix ou códigos de ações; cadastro não é preço.
    add('consultarCadastrosPublicos', 'Lista parcial de moedas, participantes Pix ou ações B3. Cadastro não é cotação.', { recurso: choice(['moedas', 'pix', 'acoes']) }, ['recurso'], brasil.cadastro)
    // Use para referência FIPE: pode descobrir marcas, modelos e anos antes de buscar o preço.
    add('consultarPrecoVeiculo', 'Fluxo FIPE marcas -> modelos -> anos -> detalhes, ou preço por código FIPE. Não inventar códigos; selecionar resultados reais.', { recurso: choice(['marcas', 'modelos', 'anos', 'detalhes', 'preco']), tipo: choice(['carros', 'motos', 'caminhoes']), codigoFipe: str('NNNNNN-N'), marca: int('Código da marca consultada'), modelo: int('Código do modelo consultado'), ano: str('Código de ano/combustível consultado') }, ['recurso'], brasil.fipe)
    // Use antes das taxas de crédito para descobrir códigos reais de modalidades disponíveis.
    add('consultarModalidadesCredito', 'Descobre códigos reais de modalidades PF/PJ e frequência D/M antes de consultar taxas de empréstimo, financiamento ou cartão.', {}, [], bcb.modalidades)
    // Use com um código de modalidade conhecido para consultar taxas médias por instituição.
    add('consultarTaxasEmprestimo', 'Taxas médias por instituição para modalidade descoberta. Não são CET ou oferta garantida. Também atende cartão e financiamentos.', { codigoModalidade: str('Código recebido de consultarModalidadesCredito'), segmento: choice(['1', '2']), mensal: { type: 'boolean', description: 'true apenas para modalidade de tipo M (imobiliário)' } }, ['codigoModalidade'], bcb.credito)
    // Daqui até os cálculos de empréstimo, as ferramentas fazem contas no próprio
    // servidor, sem consultar API. A taxa e os valores precisam vir dos argumentos.
    const investmentArgs = { capital: num('Capital inicial BRL'), taxaPercentual: num('Taxa percentual por período, não fração'), periodos: int('Quantidade de períodos na mesma unidade da taxa'), aporte: num('Aporte ao fim de cada período; padrão zero') }
    // Use para projetar um investimento com taxa e prazo informados, incluindo aportes opcionais.
    add('calcularJurosCompostos', 'Projeção bruta com taxa constante explicitamente conhecida; identifica premissas e aportes.', investmentArgs, ['capital', 'taxaPercentual', 'periodos'], calc.investment)
    // Use para comparar valor inicial e final e calcular o retorno do período.
    add('calcularRentabilidade', 'Retorno simples sobre capital único; inflação opcional do mesmo período.', { capital: num('Capital inicial'), valorFinal: num('Valor final'), inflacaoPercentual: num('Inflação acumulada do mesmo período') }, ['capital', 'valorFinal'], calc.returnRate)
    // Use para descontar impostos e custos informados de uma aplicação única.
    add('calcularRentabilidadeLiquida', 'Aplicação única: IOF sobre ganho, IR após IOF. Informar alíquotas confirmadas; não inferir tributação.', { capital: num('Capital inicial'), valorFinalBruto: num('Valor final bruto'), aliquotaIRPercentual: num('IR explícito, 0 a 100'), aliquotaIOFPercentual: num('IOF explícito, padrão zero'), custos: num('Custos monetários explícitos') }, ['capital', 'valorFinalBruto', 'aliquotaIRPercentual'], calc.netReturn)
    const loanArgs = { principal: num('Valor financiado'), taxaMensalPercentual: num('Taxa mensal percentual conhecida'), meses: int('Número de parcelas'), custosIniciais: num('Custos pagos à vista') }
    // Use para simular financiamento com parcelas constantes no sistema Price.
    add('simularFinanciamentoPrice', 'Parcelas constantes com taxa mensal fixa. Não calcula CET.', loanArgs, ['principal', 'taxaMensalPercentual', 'meses'], a => calc.financing(a, 'Price'))
    // Use para simular financiamento com amortização constante no sistema SAC.
    add('simularFinanciamentoSAC', 'Amortização constante e parcelas decrescentes. Não calcula CET.', loanArgs, ['principal', 'taxaMensalPercentual', 'meses'], a => calc.financing(a, 'SAC'))
    // Use para calcular quanto aportar por mês para alcançar uma meta no prazo informado.
    add('calcularMetaFinanceira', 'Aporte mensal necessário para meta, sem impostos/custos.', { meta: num('Objetivo BRL'), inicial: num('Valor já disponível'), meses: int('Prazo em meses'), taxaMensalPercentual: num('Taxa mensal conhecida, padrão zero') }, ['meta', 'meses'], calc.goal)
    // Use para comparar duas taxas mensais conhecidas sobre o mesmo capital e prazo.
    add('compararInvestimentos', 'Comparação bruta de duas taxas mensais explícitas, sem aportes nem impostos.', { capital: num('Capital inicial'), meses: int('Meses'), taxaMensalAPercentual: num('Taxa mensal A'), taxaMensalBPercentual: num('Taxa mensal B') }, ['capital', 'meses', 'taxaMensalAPercentual', 'taxaMensalBPercentual'], calc.compare)
    // Use para calcular o custo dos pagamentos informados; não substitui o CET do contrato.
    add('analisarCustoDeEmprestimo', 'Taxa implícita e custo dos fluxos informados, sem substituir CET contratual.', { valorRecebido: num('Valor recebido'), parcela: num('Parcela mensal fixa'), meses: int('Número de parcelas'), custosIniciais: num('Custos pagos à vista') }, ['valorRecebido', 'parcela', 'meses'], calc.loanCost)
    // Use para projetar investimento em percentual do CDI, consultando a taxa antes da conta.
    add('simularInvestimentoCDI', 'Busca CDI diário oficial e projeta taxa constante para dias úteis informados, não usa contagem fictícia de dias úteis. Retorno bruto; IR e IOF somente se explicitamente informados.', { capital: num('Capital BRL'), percentualCDI: num('100 para 100% CDI'), diasUteis: int('Dias úteis de rendimento explicitamente informados'), aliquotaIRPercentual: num('IR confirmado para produto/prazo'), aliquotaIOFPercentual: num('IOF confirmado para prazo') }, ['capital', 'percentualCDI', 'diasUteis'], async a => {
        v.number(a.capital, 'capital', 0, 1e10); v.number(a.percentualCDI, 'percentualCDI', 0, 300); v.integer(a.diasUteis, 'diasUteis', 1, 2520)
        // Esta simulação mistura consulta e conta: primeiro busca o CDI no Banco
        // Central, depois aplica a última taxa nos dias úteis que foram informados.
        const cdi = await bcb.serie({ codigo: 12 })
        const taxa = cdi.dados.pontos.at(-1).valor
        const bruto = calc.investment({ capital: a.capital, taxaPercentual: taxa * a.percentualCDI / 100, periodos: a.diasUteis })
        return { tipo: 'simulacao_cdi', fonte: cdi.fonte, dataReferencia: cdi.dataReferencia, consultadoEm: cdi.consultadoEm, desatualizado: cdi.desatualizado, dados: { taxaDiariaPercentual: taxa, ...bruto, liquido: a.aliquotaIRPercentual === undefined || a.aliquotaIOFPercentual === undefined ? null : calc.netReturn({ capital: a.capital, valorFinalBruto: bruto.valorFinalBruto, aliquotaIRPercentual: a.aliquotaIRPercentual, aliquotaIOFPercentual: a.aliquotaIOFPercentual }) }, observacoes: ['Último CDI diário repetido em todos os dias úteis: projeção hipotética, não previsão da trajetória do CDI. Não representa taxa de um produto contratado.', 'Retorno líquido indisponível sem alíquotas de IR e IOF confirmadas.'] }
    })
    // Chamada pelo orchestrator somente depois que a IA pediu uma ferramenta.
    // A IA pode sugerir um pedido, mas só este catálogo decide o que pode executar.
    async function execute(name, args) {
        // Rejeita nomes inventados e campos que a ferramenta não declarou.
        if (!Object.hasOwn(registry, name)) throw error('FERRAMENTA_NAO_PERMITIDA')
        v.objectArgs(args)
        const schema = registry[name].definition.function.parameters
        if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw error('ARGUMENTO_NAO_PERMITIDO')
        // Verifica se os dados obrigatórios chegaram e se cada valor tem o tipo,
        // tamanho e opção esperados. Assim, o pedido não vai direto da IA para a API.
        for (const key of schema.required) if (!Object.hasOwn(args, key)) throw error('ARGUMENTO_OBRIGATORIO:' + key)
        for (const [key, value] of Object.entries(args)) {
            const field = schema.properties[key]
            if (field.type === 'integer' ? !Number.isInteger(value) : typeof value !== field.type) throw error('TIPO_INVALIDO:' + key)
            if (field.type === 'number' && !Number.isFinite(value)) throw error('TIPO_INVALIDO:' + key)
            if (typeof value === 'string' && value.length > (field.maxLength || 100)) throw error('ARGUMENTO_GRANDE')
            if (field.enum && !field.enum.includes(value)) throw error('VALOR_NAO_PERMITIDO:' + key)
        }
        options.signal?.throwIfAborted()
        // Pedido aprovado: chama o provider ou cálculo ligado ao nome da ferramenta.
        return registry[name].execute(args)
    }
    // definitions é o catálogo enviado à IA; execute roda os pedidos aprovados;
    // stats fornece contagens de uso para os logs, sem incluir os resultados ou secrets.
    return { definitions: Object.values(registry).map(item => item.definition), execute, get stats() { return { ...client.stats, webSearches: tavily.stats.calls } } }
}
module.exports = { createRegistry }
