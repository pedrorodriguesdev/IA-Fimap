# Fimap AI

Repositório independente da IA financeira do FIMAP. O Worker `ia-fimap` atende a interface web e as perguntas no mesmo endereço. O back-end principal continua responsável por autenticação, banco de dados, contas, consentimentos e histórico persistente.

## Executar

Requer Node.js 22.14 ou superior e uma conta Cloudflare com Workers AI habilitado.

```sh
npm ci
npx wrangler login
npm run dev
```

Abra http://localhost:8787. A página roda localmente, mas a inferência usa Workers AI na nuvem e consome a cota da conta. Não é necessário Ollama nem um servidor Express neste projeto. Se precisar de chaves opcionais, copie `.dev.vars.example` para `.dev.vars` e configure somente a cópia.

## Publicar

```sh
npm run typecheck
npm test
npm run build
npm run deploy
```

`wrangler.jsonc` é a configuração ativa. A publicação cria/atualiza apenas `ia-fimap` na conta declarada. O endereço definitivo é o retornado pelo Wrangler; os Workers antigos não são atualizados por este projeto.

O front usa o próprio domínio. Se hospedar o front em outro domínio, ajuste `public/config.js` e declare esse domínio em `ALLOWED_ORIGINS` no Worker. Isso não é necessário para chamadas feitas pelo servidor do back-end.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `public/` | Arquivos públicos do navegador, sem segredos |
| `public/assets/app.css` | Layout responsivo |
| `public/assets/chat.js` | Envio, SSE, histórico temporário, cancelamento e exportação |
| `public/assets/ai-renderer.js` | Markdown sanitizado e cartões financeiros |
| `src/worker.ts` | Entrega da página e encaminhamento à API |
| `src/index.ts` | API de IA, validação, autenticação, limites e geração |
| `src/ai-system-prompt.js` | Identidade e regras da assistente |
| `src/ai-presentation-prompt.js` | Contrato visual das respostas |
| `src/services/financial/` | Ferramentas, cálculos e provedores financeiros |
| `src/services/webSearch/` | Pesquisa Tavily opcional |
| `src/services/chatProtocol.js` | Tratamento de eventos SSE |
| `src/services/publicChatService.js`, `src/config/ia.js` | Adaptador Node para a futura integração no back-end |
| `src/app.js` | Fragmento Express que já estava sendo editado; preservado, fora da execução do Worker |
| `tests/` | Testes automatizados da IA e dos provedores |
| `scripts/` | Validação de navegador e de inferência real |
| `docs/` | Contrato, publicação, integração e pendências |
| `archive/` | Configurações e arquivos antigos preservados, fora da execução |

`src/testUiWorker.ts` é um alias de compatibilidade. Não há mais duas configurações ativas de publicação. Os comandos `ui:*` continuam disponíveis como aliases dos comandos principais.

## API

| Método e rota | Uso |
| --- | --- |
| `GET /health` | Disponibilidade do serviço e presença do binding de IA; não executa inferência |
| `POST /v1/ia/chat-publico` | Chat da página web, sem dados privados ou login |
| `POST /v1/ia/chat` | Integração servidor a servidor, com `Authorization: Bearer TOKEN` |
| `POST /chat` | Compatibilidade legada, também exige token; retorna SSE do provedor |

As rotas novas recebem `{ "messages": [{ "role": "user", "content": "Olá" }] }` e retornam SSE com eventos `trecho`, `fim` ou `erro`. O prompt é aplicado no próprio Worker. Não é preciso enviá-lo pelo back-end. Limites: até 12 mensagens, 2000 caracteres por pergunta, 16000 por resposta no contexto e cinco segundos entre perguntas por IP, além de 12 pedidos/minuto. Mensagens inválidas não consomem o intervalo de cinco segundos.

A rota privada retorna 503 enquanto `CHAT_API_TOKEN` não estiver configurado, e 401 quando o token estiver ausente/incorreto. O chat público funciona independentemente dessa configuração.

## Validação

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
npm run test:live -- https://SEU-WORKER.workers.dev
npm run test:browser -- https://SEU-WORKER.workers.dev
```

Os testes de navegador usam Edge instalado, em modo headless. Em outro ambiente, configure `BROWSER_EXECUTABLE_PATH` para o executável Chromium/Chrome instalado. O primeiro comando de navegador usa respostas controladas; com uma URL adicional, também faz uma pergunta real na interface publicada. `test:live` consome inferência real e verifica respostas, contexto e o protocolo de streaming. Capturas e resultados ficam em `artifacts/`, fora do Git.

As seis consultas diretas aos provedores são opcionais em `financial-live.test.js` (`FINANCIAL_LIVE_TESTS=1`). São separadas dos testes determinísticos para não depender de disponibilidade externa.

## Próximos passos

Leia [como conectar o back-end](docs/backend-integration.md), [as pendências](docs/next-steps.md) e [a validação realizada](docs/validation.md).

O `.env` local foi preservado e retirado do versionamento. Ele continha credenciais no commit inicial: removê-lo dos próximos commits não apaga o histórico. Revogue/rotacione essas credenciais nos respectivos serviços. Não publique `.env` nem copie seu conteúdo para `public/`.
