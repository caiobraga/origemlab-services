# scraper-runner

Orquestra scrapers por **fonte** (sites de editais), grava em **Supabase** (`editais`, `edital_pdfs`) e publica eventos no **EventBridge** (`NewEditaisFound`, `ScraperRunCompleted`, `JobFailed`, etc.).

**Produção (pipelines):** `OLLAMA_BASE_URL=http://origemlab-ollama-nlb-312422980eebe2d0.elb.us-east-1.amazonaws.com:11434` (fase document-processor no ingestion-pipeline).

## Requisitos

- Node **≥ 20**
- Credenciais Supabase e (em AWS) permissões para EventBridge; localmente podes usar `DISABLE_EVENTBRIDGE=1`

## Configuração

1. Na raiz do repo `origemlab-services`, copia e preenche [`.env.example`](../../.env.example) → `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, opcionais de rede/timeouts).
2. O entrypoint carrega env via `src/loadEnv.mjs` (inclui o `.env` da raiz do monorepo quando corres a partir desta pasta).

## Correr localmente

```bash
cd origemlab-services/services/scraper-runner
npm install
npm run run -- --source finep
```

- **Todas as fontes:** `npm run run:all` ou `npm run run -- --source all`
- **Fonte única:** `--source <chave>`; chaves válidas incluem: `finep`, `rotadofomento`, `plataforma-inovacao-industria`, `fapern`, `capta`, `fapac`, `secti`, `funcap`, `facepe`, `fapdf`, `fapeal`, `fapema`, `fapepi`, `fapergs`, `faperj`, `fapesc`, `fapespa`, `fapesq`, `fapitec`, `fapt` (ver `SOURCES` em `src/main.mjs`).

## Docker

```bash
docker build -t origemlab-scraper-runner .
docker run --rm --env-file ../../.env origemlab-scraper-runner
```

## Deploy (AWS)

Imagem **ECR** + stack **CloudFormation** Fargate (agendado ou conforme template). Passos e variáveis GitHub: secção **services/scraper-runner** no [README do repositório](../../README.md).
