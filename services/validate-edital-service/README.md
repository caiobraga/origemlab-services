# validate-edital-service

Replica o script **`api:validate-editais-corretos`**: lê editais e documentos no **Supabase**, usa **Ollama** (embed + geração) para validar/ajustar campos e grava de volta conforme a lógica do script original.

## Requisitos

- Node **≥ 20**
- `tsx` via `npm install`

## Configuração

**Obrigatório:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OLLAMA_BASE_URL` (produção: NLB AWS). Modelos/timeouts e limites de lote: bloco **validate-edital-service** em [`.env.example`](../../.env.example).

**Auditoria (alinhada ao process-edital):** por campo, (1) trecho de evidência da extração; (2) varredura sequencial do documento em lotes pequenos (`VALIDATE_AUDIT_BATCH_*`, default ~4500 chars); timeout num lote → próximo lote; timeout no campo → mantém valor original. Compartilha `OLLAMA_GENERATE_TIMEOUT_MS`, `OLLAMA_NUM_PREDICT`, `PROCESS_EDITAL_GENERATE_DELAY_MS` com o process-edital.

## Correr localmente

```bash
cd origemlab-services/services/validate-edital-service
npm install
npm run start
```

Entrypoint: `src/api/validateEditaisCorretos.ts` (env via `src/load-env.ts` e ficheiros `.env`).

## Deploy (AWS)

`deploy-validate-edital-service.yml` → ECR `origemlab-validate-edital-service` + `infrastructure/ecs-validate-edital-service.yml`. Variáveis GitHub e **ECS_ORCHESTRATION_MODE**: [README do repositório](../../README.md).
