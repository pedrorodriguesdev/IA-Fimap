# Conexão do back-end com a IA

A interface deste repositório já conversa diretamente com a rota pública do Worker. Para conectar o aplicativo principal, o fluxo será:

```text
Front do aplicativo -> Back-end (login e dados) -> Worker ia-fimap -> Workers AI
Front do aplicativo <- Back-end (SSE e histórico) <- Worker ia-fimap
```

## 1. Criar o token compartilhado

Escolha um token aleatório longo e guarde-o no gerenciador de segredos. No terminal deste repositório:

```sh
npx wrangler secret put CHAT_API_TOKEN
```

Cole o token quando o Wrangler solicitar. Não coloque o token em `wrangler.jsonc`, no código, em `public/config.js` ou em variáveis expostas ao navegador. Não há um token novo gerado e publicado automaticamente neste trabalho.

## 2. Configurar o back-end separado

No `.env` ou gerenciador de segredos do BACK-END:

```dotenv
CLOUDFLARE_WORKER_URL=https://ia-fimap.fimap-agency.workers.dev/v1/ia/chat
CLOUDFLARE_CHAT_TOKEN=O_MESMO_TOKEN_CONFIGURADO_NO_WORKER
```

Use o domínio exato retornado pela publicação e registrado em `validation.md`. O `.env` do back-end não é enviado ao Worker; cada serviço tem sua própria configuração.

## 3. Fazer o pedido

Exemplo Node.js 22, executado apenas no servidor:

```js
const response = await fetch(process.env.CLOUDFLARE_WORKER_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.CLOUDFLARE_CHAT_TOKEN}`,
  },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Recebo R$ 5000 e gasto R$ 3200.' },
      { role: 'assistant', content: 'Sobram R$ 1800 por mês.' },
      { role: 'user', content: 'Como posso planejar minha reserva?' },
    ],
  }),
  signal: AbortSignal.timeout(180000),
})
if (!response.ok) throw new Error(`IA indisponível: HTTP ${response.status}`)
```

O Worker insere o prompt. Envie somente `user` e `assistant`, terminando com a pergunta atual. Use no máximo cinco pares anteriores e a pergunta nova. Não é necessário manter uma cópia do prompt no back-end.

A resposta é `text/event-stream`, não JSON único:

```text
data: {"tipo":"trecho","conteudo":"Vamos organizar sua reserva."}

data: {"tipo":"fim"}
```

Falhas durante a geração usam `{"tipo":"erro","mensagem":"..."}`. Só marque a resposta como concluída e salve-a no histórico depois de receber `fim`. Se a conexão fechar antes disso, trate como incompleta. Preserve os pacotes até encontrar linhas vazias: um JSON pode chegar dividido entre leituras.

O adaptador em `src/services/publicChatService.js` já faz esse tratamento e envia o Bearer. Para levá-lo ao back-end, inclua também `src/services/chatProtocol.js` e `src/config/ia.js`, preservando os imports, ou adapte os caminhos. `gerarResposta(messages, onChunk, signal)` entrega cada trecho ao callback, retorna a resposta completa e rejeita em erro/cancelamento.

Se o back-end já possui um parser para o SSE cru do modelo, a rota legada `/chat` foi preservada com Bearer. A rota recomendada para novas integrações é `/v1/ia/chat`, com o protocolo FIMAP acima.

## 4. Encaminhar o SSE ao front do aplicativo

No controller autenticado do back-end:

- Obtenha o usuário da sessão/JWT validado pelo back-end.
- Leia o histórico desse usuário no banco e selecione as últimas mensagens completas.
- Faça o pedido ao Worker com o token do servidor.
- Envie os trechos ao navegador com `Content-Type: text/event-stream; charset=utf-8` e `Cache-Control: no-cache, no-transform`.
- Cancele o fetch quando o navegador desconectar ou pedir para parar.
- Persista a resposta somente após a conclusão confirmada. Respeite a pressão de leitura do stream e desabilite buffering do proxy para SSE.

O front do aplicativo chama o seu back-end autenticado; o token compartilhado nunca vai para o navegador. Chamadas servidor a servidor não precisam de CORS. Se um front em outro domínio chamar a rota pública diretamente, esse domínio precisa estar em `ALLOWED_ORIGINS` no Worker; CORS não substitui autenticação.

## 5. Dados financeiros do usuário: etapa posterior

O contrato atual aceita somente `messages`. Não foi criada uma integração de banco, usuário, saldo, Open Finance nem um campo estruturado `contextoFinanceiro`. Dados fornecidos manualmente em uma mensagem são usados apenas como contexto da conversa.

Antes de implementar essa etapa, definir o JSON de dados autorizados, os campos necessários, limites de tamanho, origem, datas, consentimentos e regras de isolamento por usuário. O back-end deve buscar e validar esses dados. A IA não deve consultar o banco diretamente nem receber senhas bancárias.

## 6. Chaves opcionais da IA

Configure os secrets no Worker quando for usar os respectivos provedores:

```sh
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put BRAPI_TOKEN
npx wrangler secret put HG_BRASIL_API_KEY
```

Sem essas chaves, as integrações correspondentes permanecem indisponíveis. Consultas públicas de outras fontes e cálculos locais continuam disponíveis. Não presuma uma chave transferida do Worker antigo para este Worker novo.

## Referências

[Static Assets na Cloudflare](https://developers.cloudflare.com/workers/static-assets/) permite publicar o front e o Worker em uma operação. [Secrets do Wrangler](https://developers.cloudflare.com/workers/configuration/secrets/) documenta a configuração das credenciais por serviço.
