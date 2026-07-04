# unified-pipeline-service

Um único container ECS executa as **quatro fases** em sequência:

1. **scraper-runner** — busca editais nas fontes
2. **document-processor** — PDF → chunks → embeddings (Ollama)
3. **process-edital-info** — extração de campos (até `PIPELINE_PROCESS_LIMIT` editais)
4. **validate-editais-corretos** — auditoria de campos → `editais_corretos`

Fases 3–4 rodam **process → validate** para que editais descobertos no mesmo ciclo possam aparecer no dashboard na mesma hora.

Substitui `ingestion-pipeline-service` + `edital-pipeline-service` por **um stack**, **um schedule** e **sem overlap** no Ollama.

## Local

```bash
cd origemlab-services
# .env na raiz com SUPABASE_*, OLLAMA_*, etc.

cd services/unified-pipeline-service
npm install
npm run start
```

## Flags de skip (por fase)

| Variável | Efeito |
|----------|--------|
| `PIPELINE_SKIP_SCRAPER=1` | Pula fase 1 |
| `PIPELINE_SKIP_DOCUMENT_PROCESSOR=1` | Pula fase 2 |
| `PIPELINE_SKIP_VALIDATE=1` | Pula fase 4 (validate) |
| `PIPELINE_SKIP_PROCESS=1` | Pula fase 3 (process) |
| `PROCESS_EDITAL_ORDER` | `new_first` (default) — prioriza editais novos |
| `PIPELINE_VALIDATE_BEFORE_PROCESS=1` | Legado: validate antes de process |
| `ECS_WORKER_LOOP=1` | Loop contínuo (modo `continuous` no ECS) |

## Deploy

`deploy-unified-pipeline-service.yml` → ECR `origemlab-unified-pipeline-service` + `infrastructure/ecs-unified-pipeline-service.yml`.

Incluído em **`deploy-all-ecs-services.yml`** (junto com Ollama).

**Default AWS:** `OrchestrationMode=scheduled`, `rate(1 hour)`.

Após migrar, apague os stacks `origemlab-ingestion-pipeline` e `origemlab-edital-pipeline` na AWS.
