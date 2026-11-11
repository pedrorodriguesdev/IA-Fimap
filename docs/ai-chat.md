# Chat FIMAP: apresentação e cancelamento

A interface de teste está em `public/index.html`. Os comandos de instalação, execução e publicação estão em [test-ui.md](test-ui.md).

`public/assets/ai-renderer.js` centraliza Markdown, métricas, avisos, tabelas, barras e cópia. `ai-chat.css` preserva o tema claro existente. Marked interpreta Markdown; HTML recebido é escapado e o resultado passa por DOMPurify com lista restrita de elementos. Links aceitam HTTP, HTTPS e mailto. Highlight.js colore código somente ao terminar.

## Contrato visual v1

Respostas normais usam Markdown. Para dados conhecidos, o modelo pode emitir um bloco de código com linguagem `fimap` contendo:

```json
{
  "version": 1,
  "title": "Análise financeira",
  "summary": "Resumo baseado nos valores informados.",
  "metrics": [
    {"label": "Receita mensal", "value": 5000, "format": "BRL"},
    {"label": "Despesas", "value": 3200, "format": "BRL"},
    {"label": "Valor restante", "value": 1800, "format": "BRL"},
    {"label": "Taxa de economia", "value": 36, "format": "percent"}
  ],
  "bars": [
    {"label": "Despesas", "value": 3200, "total": 5000},
    {"label": "Valor restante", "value": 1800, "total": 5000}
  ],
  "callouts": [{"type": "recomendacao", "text": "Avalie sua reserva de emergência."}]
}
```

Valores acima são fictícios, apenas para documentar o contrato; não são injetados no chat. Formatos: `BRL`, `percent` (36 significa 36%), `number`. Até oito métricas e oito barras. Barras exigem total positivo e valor entre zero e total; são uma representação da proporção fornecida, sem cálculos financeiros novos. Avisos: `resumo`, `informacao`, `atencao`, `dica`, `comparacao`, `recomendacao`. Blocos inválidos permanecem como texto/código. Textos e números comuns nunca são convertidos automaticamente em cartões.

O prompt compartilhado em `src/ai-presentation-prompt.js` é aplicado pelo Worker. O contrato mantém o transporte SSE `{tipo:"trecho",conteudo:"..."}` e o marcador `{tipo:"fim"}`.

## Streaming e cancelamento

O protocolo FIMAP envia `trecho`, `fim` e `erro`. A interface só inclui pares completos no contexto seguinte. Parar cancela a requisição e preserva o texto parcial identificado como interrompido. O Worker cancela a leitura do stream e libera o intervalo local após o cancelamento. O limite de 12 pedidos/minuto continua ativo.

Falhas do provedor, respostas vazias, SSE malformado e interrupções são tratados sem marcar sucesso. Eventos de raciocínio não são apresentados como resposta ao usuário. O adaptador Node aceita SSE normalizado e o legado, e verifica o marcador de conclusão.

## Prompts e validação

Edite `src/ai-system-prompt.js` para identidade e regras, e `src/ai-presentation-prompt.js` para apresentação. A rota `/v1/ia/chat` aplica os prompts no Worker; o back-end não precisa enviar `system`. `/chat` mantém compatibilidade com o prompt compartilhado exato. Ambas as rotas privadas exigem token.

`npm test`, `npm run typecheck`, `npm run build` e `npm run test:browser` verificam código e interface. `npm run test:live -- URL` testa a IA publicada. Veja [validation.md](validation.md) e [backend-integration.md](backend-integration.md).
