# Interface web

A interface agora é parte oficial do projeto e fica em `public/`. `npm run dev` abre o desenvolvimento; `npm run deploy` publica a interface e a IA juntas no Worker `ia-fimap`. Os aliases `ui:dev`, `ui:build` e `ui:deploy` apontam para os mesmos comandos.

A página consulta `/health` para indicar disponibilidade do serviço e faz perguntas em `/v1/ia/chat-publico` no próprio domínio. O indicador “Serviço disponível” confirma apenas o health check; “IA respondeu” aparece depois de uma resposta real concluída.

Layout em `public/assets/app.css`, lógica em `public/assets/chat.js` e apresentação das respostas em `public/assets/ai-renderer.js` e `ai-chat.css`. Bibliotecas de Markdown, sanitização e destaque de código já estão em `public/assets/vendor/`; não há dependência de CDN no navegador.

Histórico somente na memória da aba, com até cinco pares completos enviados como contexto. Cancelamentos, respostas vazias e falhas não entram no contexto. “Nova conversa” limpa o contexto; “Exportar” baixa uma cópia em Markdown. Enter envia e Shift+Enter adiciona uma linha.

Os arquivos antigos estão preservados em `archive/`, incluindo `Pluggy.html`, que não é publicado. O arquivo não vazio em edição `src/app.js` também foi preservado: é um fragmento Express e não faz parte da entrada do Worker.

A validação da interface usa `npm run test:browser`. Consulte [README](../README.md), [integração](backend-integration.md) e [validação](validation.md).
