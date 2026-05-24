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

**Ollama lento / `UND_ERR_HEADERS_TIMEOUT`:** reduzir **tamanho do contexto** e **paralelismo** costuma ajudar mais do que só subir timeout.

Variáveis GitHub recomendadas (Ollama ECS partilhado):

| Variável | Sugestão | Efeito |
|----------|----------|--------|
| `OLLAMA_SERVICE_TASK_CPU` / `MEMORY` | `8192` / `16384` | deploy do **ollama-service** (não deste stack) |
| `OLLAMA_GENERATE_TIMEOUT_MS` | `900000` | margem por chamada (local: não usar `180000`) |
| `OLLAMA_MAX_CONTEXT_CHARS` | `10000` | teto global; por lote usa `MAX_FIELD_CONTEXT_CHARS` |
| `PROCESS_EDITAL_TOP_K` | `40` | top-k global (evitar `10`) |
| `PROCESS_EDITAL_TOP_K_TIMELINE_ESTIMADA` | `70` | cronograma em editais grandes |
| `PROCESS_EDITAL_FULLDOC_MAX_BATCHES` | `50` | evita 200+ lotes sequenciais |
| `PROCESS_EDITAL_USE_WINDOWS` | `1` | fallback por janelas |
| `PROCESS_EDITAL_CONCURRENCY` | `1` | 1 edital de cada vez |
| `PROCESS_EDITAL_FIELD_CONCURRENCY` | `1` | 1 campo de cada vez |

O `capContextForModel()` já trunca ao `OLLAMA_MAX_CONTEXT_CHARS`; top-k empacota por score até esse teto. Redeploy do **edital-pipeline** após mudar variáveis (task definition).

Para só agendar (0 services entre runs): `EDITAL_PIPELINE_ORCHESTRATION_MODE=scheduled` no GitHub + `EDITAL_PIPELINE_SCHEDULE_EXPRESSION` (ex. `rate(30 minutes)`).

Após migrar, **escala para 0** ou remove os stacks antigos `process-edital` e `validate-edital`.
