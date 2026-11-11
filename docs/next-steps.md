# Estado do projeto e próximas etapas

| Item | Estado |
| --- | --- |
| Repositório independente da IA | Estrutura, dependências e comandos organizados |
| Worker `ia-fimap` | Configuração única para interface e API |
| Interface web | Responsiva, Markdown e cartões, parar, tentar novamente, exportar e nova conversa |
| Ferramentas financeiras | Preservadas; disponibilidade real depende das APIs e credenciais |
| Integração de pesquisa web | Tavily preservado; precisa de secret no Worker novo |
| Rota do back-end | Implementada e protegida; aguarda configurar `CHAT_API_TOKEN` |
| Login e histórico persistente | Permanecem no back-end principal; não implementados aqui |
| Receber saldos/transações/metas | Definir e implementar contrato estruturado na próxima etapa |
| Credenciais antigas do `.env` | Arquivo local preservado e retirado do índice Git; rotacionar credenciais já presentes no histórico |
| Fragmento `src/app.js` | Edição existente preservada; não executar como aplicação Node, pois não define `app` |

Para conectar o back-end, siga [backend-integration.md](backend-integration.md). Para os resultados observados da IA real, veja [validation.md](validation.md). Nenhum teste garante respostas corretas para todas as perguntas futuras.
