# validate-edital-service

Replica o script **`api:validate-editais-corretos`**: lê editais e documentos no **Supabase**, usa **Ollama** (embed + geração) para validar/ajustar campos e grava de volta conforme a lógica do script original.

## Requisitos

- Node **≥ 20**
- `tsx` via `npm install`

## Configuração

**Obrigatório:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OLLAMA_BASE_URL`. Modelos/timeouts e limites de lote: bloco **validate-edital-service** em [`.env.example`](../../.env.example) (`VALIDATE_EDITAIS_LIMIT`, `OLLAMA_EMBED_MODEL`, `VALIDATE_SKIP_POLISH`, etc.).

## Correr localmente

```bash
cd origemlab-services/services/validate-edital-service
npm install
npm run start
```

Entrypoint: `src/api/validateEditaisCorretos.ts` (env via `src/load-env.ts` e ficheiros `.env`).

## Deploy (AWS)

`deploy-validate-edital-service.yml` → ECR `origemlab-validate-edital-service` + `infrastructure/ecs-validate-edital-service.yml`. Variáveis GitHub e **ECS_ORCHESTRATION_MODE**: [README do repositório](../../README.md).
