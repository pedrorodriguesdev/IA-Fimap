# Fimap AI

Repositório independente da IA financeira do FIMAP. O Worker `ia-fimap` atende a interface web e as perguntas no mesmo endereço. O back-end principal continua responsável por autenticação, banco de dados, contas, consentimentos e histórico persistente.

Site e Worker hospedados na conta `fimap.agency@gmail.com`: https://ia-fimap.fimap-agency.workers.dev

A geração da IA usa a conta indicada nos secrets `AI_PROVIDER_ACCOUNT_ID` e `AI_PROVIDER_API_TOKEN`. Planejamento de ferramentas e respostas usam essa mesma conta via REST. A configuração de produção não possui binding `AI` da conta que hospeda o site.

## Executar

Requer Node.js 22.14 ou superior e uma conta Cloudflare com Workers AI habilitado.

```sh
npm ci
npm run doctor
npx wrangler login
npm run dev
```

Copie `.dev.vars.example` para `.dev.vars` e preencha `AI_PROVIDER_ACCOUNT_ID` e `AI_PROVIDER_API_TOKEN` somente na cópia. Abra http://localhost:8787. A página roda localmente, mas a inferência usa Workers AI na nuvem e consome a cota da conta provedora. Não é necessário Ollama nem um servidor Express neste projeto.

## Publicar

```sh
npm run check
npm run deploy
```

`wrangler.jsonc` é a configuração ativa. A publicação cria/atualiza apenas `ia-fimap` na conta declarada. O endereço definitivo é o retornado pelo Wrangler; os Workers antigos não são atualizados por este projeto.

O front usa o próprio domínio. Se hospedar o front em outro domínio, ajuste `public/config.js` e declare esse domínio em `ALLOWED_ORIGINS` no Worker. Isso não é necessário para chamadas feitas pelo servidor do back-end.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `public/` | Arquivos públicos do navegador, sem segredos |
| `public/assets/app.css` | Layout responsivo |
| `public/assets/fimap-logo.png` | Logo original, usada no cabeçalho e no ícone da aba |
| `public/assets/chat.js` | Envio, SSE, contexto temporário, cancelamento e nova tentativa |
| `public/assets/ai-renderer.js` | Markdown sanitizado e cartões financeiros |
| `src/worker.ts` | Entrega da página e encaminhamento à API |
| `src/index.ts` | API de IA, validação, autenticação, limites e geração |
| `src/services/aiProvider.js` | Chamadas REST à conta provedora, streaming e tratamento de falhas |
| `src/ai-system-prompt.js` | Identidade e regras da assistente |
| `src/ai-presentation-prompt.js` | Contrato visual das respostas |
| `src/services/financial/` | Ferramentas, cálculos e provedores financeiros |
| `src/services/webSearch/` | Pesquisa Tavily opcional |
| `src/services/chatProtocol.js` | Tratamento de eventos SSE |
| `src/services/publicChatService.js` | Adaptador Node para a integração no back-end separado |
| `tests/` | Testes automatizados da IA e dos provedores |
| `scripts/` | Validação de navegador e de inferência real |
| `docs/backend-integration.md` | Integração com o back-end principal |

Há uma única configuração de publicação e uma única entrada web: `wrangler.jsonc` e `src/worker.ts`.

## Diagnóstico e troca da conta de IA

Uma cópia nova do Git não inclui `node_modules`. Execute `npm ci` uma vez nesta cópia e novamente quando o lockfile mudar. Instalar dependências locais não publica o site, não renova cota e não altera secrets.

- `npm run doctor`: verifica Node.js e as dependências locais, sem chamar a IA.
- `npm run doctor:live`: faz uma pergunta real ao site e exige resposta completa; consome cota. Aceita outra base: `npm run doctor:live -- https://SEU-WORKER.workers.dev`.
- `npm run ai:configure`: pede o Account ID e o token em um terminal interativo (token oculto), testa o modelo na conta fornecida e só então envia os dois secrets juntos ao Worker. Uma falha de formato, autenticação, acesso ou cota impede essa substituição.
- `npm run check`: executa TypeScript, testes e bundle sem publicar. Também roda automaticamente antes de `npm run deploy`.

Mantenha o Wrangler conectado à conta que hospeda `ia-fimap`. O Account ID e o token informados em `ai:configure` são da conta que fornece a IA, com permissões Workers AI Read/Edit. Não use e-mail, Zone ID, nome/ID do token, aspas ou prefixo Bearer no lugar dos valores. O token precisa ter acesso à conta indicada.

`/health` verifica somente o formato da configuração. HTTP 200 e `iaConfigurada: true` não confirmam autenticação ou cota. `doctor:live` verifica esses pontos naquele momento. Depois de um deploy, o diagnóstico real roda automaticamente: se falhar, o deploy pode já estar ativo e precisa ser investigado, sem presumir rollback automático.

O fluxo do GitHub em `.github/workflows/check.yml` verifica Linux/Windows e testa a interface em Windows; não publica nem usa secrets. Os testes automáticos locais usam respostas controladas. Os comandos com `live` e o configurador usam a IA real.

Leia a [auditoria de 13/11/2026](docs/audit-2026-11-13.md) para as evidências do incidente e os limites desta prevenção.

## Como a pergunta vira uma resposta com dados de API

O `financialChatOrchestrator.js` coordena o processo. A própria IA escolhe qual ferramenta solicitar entre as opções do catálogo; o código valida o pedido antes de executar.

1. **Você envia a pergunta.** A página manda a mensagem ao Worker, e o `src/index.ts` valida o formato, o tamanho e os limites de uso.
2. **O coordenador apresenta as ferramentas à IA.** O `financialChatOrchestrator.js` envia a conversa e as definições do `financialToolRegistry.js` ao modelo. Cada definição explica o que a ferramenta faz e quais dados aceita.
3. **A IA solicita uma ferramenta.** Por exemplo, pode pedir `localizarEndereco({ endereco: "São Paulo" })`. A IA pede a execução; quem faz a consulta externa é o servidor.
4. **O catálogo valida o pedido.** O `financialToolRegistry.js` confere se a ferramenta existe, se os campos obrigatórios chegaram e se os argumentos têm tipos, tamanhos e opções permitidos. Depois encaminha para a função cadastrada.
5. **A conexão com o fornecedor consulta a API.** Um arquivo como `providers/geoapify.js` monta a requisição, usa a chave configurada no servidor e organiza a resposta recebida. O cliente HTTP aplica limites, tempo de espera e tratamento de erros.
6. **O resultado volta para a IA.** A função devolve os dados pelo catálogo ao coordenador, que os acrescenta à conversa temporária como resultado da ferramenta.
7. **A IA escreve a resposta.** Com os dados recebidos, o modelo prepara o texto que chega ao chat em pedaços (streaming). O `aiProvider.js` cuida da comunicação com o modelo tanto na escolha das ferramentas quanto na geração da resposta final.

Se uma consulta depender de outra, o coordenador pode repetir o ciclo antes da resposta final, respeitando o limite de até quatro pedidos novos em três rodadas. Por exemplo: localizar um endereço, receber suas coordenadas e usá-las para buscar supermercados próximos.

Perguntas que não precisam de dados externos podem seguir sem ferramentas. Ferramentas de cálculo fazem as contas no servidor, sem necessariamente consultar uma API. Se uma consulta falhar, o erro volta à IA para ela explicar a limitação sem inventar resultados.

## Interface

A tela segue a referência visual: navegação superior, histórico à esquerda, conversa com cartões à direita e campo de mensagem na base. Navegação, busca e ícones são estáticos. O chat permite enviar, receber streaming, parar, tentar novamente, copiar uma resposta e iniciar uma nova conversa.

A página abre com a conversa e o histórico vazios, sem mensagens de exemplo. A primeira pergunta envia apenas o texto digitado pelo usuário. O contexto fica na memória da aba; “Nova conversa” limpa as mensagens, o rascunho e o contexto, e cancela uma resposta em andamento. Recarregar também volta à tela vazia. No celular, o histórico lateral fica oculto para dar espaço à conversa.

O [prompt de apresentação](src/ai-presentation-prompt.js) define o contrato visual das respostas. O [renderer](public/assets/ai-renderer.js) interpreta Markdown com Marked, sanitiza o HTML com DOMPurify e destaca código com Highlight.js. Links aceitam HTTP, HTTPS e mailto. As bibliotecas ficam em `public/assets/vendor/`, sem depender de CDN.

Para valores conhecidos, o modelo pode emitir um bloco `fimap` em JSON com `version: 1`, `title`, `summary`, `metrics`, `bars` e `callouts`. São permitidas até oito métricas (`BRL`, `percent` ou `number`) e oito barras com `0 <= value <= total` e `total > 0`. Percentuais usam pontos percentuais (36 significa 36%). Avisos aceitam `resumo`, `informacao`, `atencao`, `dica`, `comparacao` e `recomendacao`. Blocos inválidos permanecem como texto/código; números comuns não são convertidos automaticamente em cartões.

## API

| Método e rota | Uso |
| --- | --- |
| `GET /health` | Disponibilidade e configuração da conta de IA; não executa inferência nem valida o token |
| `POST /v1/ia/chat-publico` | Chat da página web, sem dados privados ou login |
| `POST /v1/ia/chat` | Integração servidor a servidor, com `Authorization: Bearer TOKEN` |
| `POST /chat` | Compatibilidade legada, também exige token; retorna SSE do provedor |

As rotas novas recebem `{ "messages": [{ "role": "user", "content": "Olá" }] }` e retornam SSE com eventos `trecho`, `fim` ou `erro`. O prompt é aplicado no próprio Worker. Não é preciso enviá-lo pelo back-end. Limites: até 12 mensagens, 2000 caracteres por pergunta, 16000 por resposta no contexto e cinco segundos entre perguntas por IP, além de 12 pedidos/minuto. Mensagens inválidas não consomem o intervalo de cinco segundos.

A rota privada retorna 503 enquanto `CHAT_API_TOKEN` não estiver configurado, e 401 quando o token estiver ausente/incorreto. O chat público funciona independentemente dessa configuração.

No Worker publicado, prefira `npm run ai:configure` para validar e enviar o par de credenciais junto. Os comandos individuais `wrangler secret put` continuam disponíveis, mas aplicam cada secret separadamente e não testam o acesso ao modelo. `/health` indica `provedorIA: "conta-externa"` quando esse modo está selecionado. Credenciais incompletas ou recusadas e cota esgotada não acionam a conta Fimap como alternativa. A cota diária gera HTTP 429 com mensagem própria; o token nunca é entregue ao navegador.

Somente pares de mensagens completos entram no contexto seguinte. Falhas, cancelamentos, respostas vazias, SSE malformado e conexões encerradas antes de `fim` são tratados como incompletos. O adaptador Node também aceita o SSE legado do provedor.

As consultas externas usam o modo `redirect: 'manual'`, compatível com o runtime Workers. Respostas HTTP 3xx são recusadas sem seguir `Location` nem reenviar credenciais para outro endereço. Consultas públicas de API podem ser testadas sem gastar a cota do modelo; perguntas ao chat dependem da cota disponível de Workers AI.

O Geoapify usa o secret `GEOAPIFY_API_KEY` e as ferramentas `localizarEndereco` e `buscarLocaisProximos`. A primeira transforma um endereço informado em coordenadas; a segunda procura supermercados, restaurantes, cafés, bancos, caixas eletrônicos e casas de câmbio próximos. Se faltar localização ou houver ambiguidade, a IA deve pedir esclarecimento. Não há leitura automática de GPS. As consultas não entram no cache compartilhado, e as respostas não comprovam preços, avaliações ou funcionamento atual dos locais. A fonte é Geoapify / OpenStreetMap. Referências: [geocodificação](https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/) e [locais](https://apidocs.geoapify.com/docs/places/).

Cadastre a chave em produção com `npx wrangler secret put GEOAPIFY_API_KEY`; em desenvolvimento, preencha somente a cópia local `.dev.vars`.

## Validação

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
npm run test:live -- https://SEU-WORKER.workers.dev
npm run test:browser -- https://SEU-WORKER.workers.dev
```

Os testes de navegador usam Edge instalado, em modo headless, ou o navegador indicado em `BROWSER_EXECUTABLE_PATH`. Neste computador, use:

```sh
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
```

Sem URL, o teste usa respostas controladas. Com URL, verifica o layout publicado e faz uma pergunta real. `test:live` verifica respostas, contexto e o protocolo de streaming com inferência real. Os testes geram capturas e resultados em `artifacts/`, fora do Git; essa pasta pode ser removida após a inspeção. `build` valida o bundle sem manter uma pasta `dist/`.

As seis consultas diretas aos provedores são opcionais em `financial-live.test.js` (`FINANCIAL_LIVE_TESTS=1`). São separadas dos testes determinísticos para não depender de disponibilidade externa.

## Próximos passos

Leia [como conectar o back-end](docs/backend-integration.md). Login, dados autorizados de contas e histórico persistente dependem dessa integração. As consultas financeiras e de pesquisa dependem da disponibilidade das fontes e das chaves opcionais configuradas.

As chaves de produção ficam nos secrets do Worker; para desenvolvimento, use `.dev.vars`. As variáveis do back-end separado estão documentadas no guia de integração. Não publique segredos em `public/`. Credenciais que já apareceram no histórico Git precisam ser rotacionadas nos serviços correspondentes.


Para trocar a conta provedora com validação prévia:
```sh
npm run ai:configure
npm run doctor:live
```
