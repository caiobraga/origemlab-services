# edital-pipeline-service

Um único container ECS executa em sequência:

1. **process-edital-info** — extrai campos dos editais (Ollama)
2. **validate-editais-corretos** — audita e grava `editais_corretos`

Substitui dois workers Fargate separados por **um único ECS Service** (default **continuous**, 24/7) que corre process + validate em loop.

**Produção:** `OLLAMA_BASE_URL=http://origemlab-ollama-nlb-312422980eebe2d0.elb.us-east-1.amazonaws.com:11434` (GitHub Variables / task env).

## Local

```bash
cd origemlab-services
# .env na raiz com SUPABASE_*, OLLAMA_*, etc.

cd services/edital-pipeline-service
npm install
npm run start
```

Opcional: `PIPELINE_SKIP_PROCESS=1` ou `PIPELINE_SKIP_VALIDATE=1` para correr só uma fase.

## Deploy

`deploy-edital-pipeline-service.yml` → ECR `origemlab-edital-pipeline-service` + `infrastructure/ecs-edital-pipeline-service.yml`.

**Default (AWS):** `OrchestrationMode=continuous` — cluster `origemlab-edital-pipeline` com **1 serviço** (`origemlab-edital-pipeline-worker`), `ECS_WORKER_LOOP=1`.

Para só agendar (0 services entre runs): `EDITAL_PIPELINE_ORCHESTRATION_MODE=scheduled` no GitHub + `EDITAL_PIPELINE_SCHEDULE_EXPRESSION` (ex. `rate(30 minutes)`).

Após migrar, **escala para 0** ou remove os stacks antigos `process-edital` e `validate-edital`.
