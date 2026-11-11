# Arquivos antigos preservados

Esta pasta não é publicada nem usada pelo Worker ativo. Não execute deploy usando os arquivos daqui: eles registram nomes e estruturas antigas.

- `wrangler.frontend-test.jsonc`: configuração antiga da página de teste.
- `wrangler-toml-original/wrangler.toml`: arquivo JSON que estava dentro de uma pasta chamada `wrangler.toml`, sem apontar para a entrada real.
- `prepare-test-ui.js`: script antigo para copiar bibliotecas do front.
- `Pluggy.html`: página local preservada.
- `backend/geoapifyPlacesService.js`: serviço Node do back-end, sem rota correspondente neste repositório.
- `worker-configuration.original.d.ts`: tipos gerados da configuração antiga. O projeto ativo usa `@cloudflare/workers-types` e o tipo `Env` de `src/index.ts`.

Os arquivos de interface antes em `frontend-test/` foram movidos para `public/`. A configuração ativa é `../wrangler.jsonc`.
