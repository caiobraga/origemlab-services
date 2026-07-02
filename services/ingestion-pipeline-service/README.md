# ingestion-pipeline-service

> **Legado** — use [`unified-pipeline-service`](../unified-pipeline-service/README.md).

Um único container ECS executa em sequência:

1. **scraper-runner** — descobre editais e envia PDFs ao Supabase Storage
2. **document-processor** — PDF → chunks → enrich → embeddings em `documents`

Substitui o par scraper (agendado) + document-processor (muitas vezes **24/7** contínuo) por **uma task agendada**.

**Produção:** `OLLAMA_BASE_URL=http://origemlab-ollama-nlb-312422980eebe2d0.elb.us-east-1.amazonaws.com:11434` (GitHub Variables / task env).

## Local

```bash
cd origemlab-services
# .env na raiz: SUPABASE_*, OLLAMA_* (document-processor), etc.

cd services/ingestion-pipeline-service
npm install
npm run start
```

Variáveis úteis: `PIPELINE_SKIP_SCRAPER=1`, `PIPELINE_SKIP_DOCUMENT_PROCESSOR=1`, `SCRAPER_SOURCE=all`.

## Deploy

`deploy-ingestion-pipeline-service.yml` → ECR `origemlab-ingestion-pipeline-service` + `infrastructure/ecs-ingestion-pipeline-service.yml`.

Default: `OrchestrationMode=scheduled` (`rate(1 hour)`). Após migrar, desligue o ECS Service contínuo do **document-processor** antigo.
