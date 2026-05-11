# origemlab-services

Serviços (Lambda) consumindo eventos do EventBridge.

## services/scraper-runner (ECS Fargate)

Para scrapers demorados e/ou com Puppeteer/Chromium, usamos **ECS Fargate (scheduled task)** em vez de Lambda.

### Rodar local (Docker)

Pré-req: Docker.

1) Crie um `.env` com:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EVENT_BUS_NAME` (opcional; para teste local pode omitir ou setar `default`)

2) Rode:

```bash
cd origemlab-services/services/scraper-runner
docker build -t origemlab-scraper-runner .
docker run --rm --env-file .env origemlab-scraper-runner
```

### Deploy (CloudFormation)

Arquivo: `infrastructure/ecs-scraper-runner.yml`

Você precisa de:

- Uma imagem no ECR para `RunnerImage`
- VPC + Subnets + Security Group com saída para Internet (para scrape e PDFs)
- Secret no Secrets Manager (ex.: `origemlab/supabase`) com chaves JSON:
  - `url`
  - `service_role_key`

O schedule dispara uma task Fargate (default: `rate(1 hour)`), e o job publica eventos no EventBridge (`source: origemlab`).

## services/document-processor (ECS Fargate)

Processa `edital_pdfs` não marcados como processados: baixa o PDF do bucket `edital-pdfs`, extrai texto, divide em chunks e, **antes do embedding**, chama o Ollama (`/api/chat`) para gerar contexto alinhado ao pipeline **`api:process-edital-info`** (tipos de pergunta, campos `valor_projeto`, `prazo_inscricao`, etc., perguntas exemplo). Esse texto enriquecido é o que vai para `documents.content` e para o vetor (melhor RAG).

Pré-requisitos:

- **Ollama** acessível em `OLLAMA_BASE_URL` (chat + embed na mesma base).
- Mesmas credenciais Supabase que o scraper.

### Rodar local

```bash
cd origemlab-services/services/document-processor
cp ../../.env.example ../../.env   # preencha SUPABASE_* e OLLAMA_*
npm install
OLLAMA_BASE_URL=http://localhost:11434 npm run start -- --limit=2
```

Flags: `--dry-run`, `--all` (reprocessa mesmo com `is_processed`), `--limit=N`.

### Deploy

Tudo via **GitHub Actions** (`deploy-document-processor.yml`): build/push da imagem para ECR `origemlab-document-processor` (`:latest` e `:${sha}`) e **`aws cloudformation deploy`** do stack definido em `infrastructure/ecs-document-processor.yml`, atualizando `ProcessorImage` a cada push.

Configure **variáveis de repositório** (Settings → Secrets and variables → Actions → Variables), além de `AWS_REGION` e `AWS_ROLE_ARN` já usados pelos outros workflows:

| Variável | Descrição |
|----------|-----------|
| `DOCUMENT_PROCESSOR_STACK_NAME` | Nome do stack CloudFormation (ex.: `origemlab-document-processor`) |
| `DOCUMENT_PROCESSOR_VPC_ID` | VPC da task |
| `DOCUMENT_PROCESSOR_SUBNET_IDS` | IDs de subnet separados por vírgula (egresso para pull da imagem e Ollama) |
| `DOCUMENT_PROCESSOR_SECURITY_GROUP_IDS` | Security groups separados por vírgula |
| `DOCUMENT_PROCESSOR_SUPABASE_SECRET_ARN` | ARN do secret no Secrets Manager (JSON: `url`, `service_role_key`) |

Opcionais: `DOCUMENT_PROCESSOR_OLLAMA_BASE_URL` (URL interna do Ollama), `DOCUMENT_PROCESSOR_SCHEDULE_EXPRESSION` (default `rate(6 hours)`), `DOCUMENT_PROCESSOR_CLUSTER_NAME`, `DOCUMENT_PROCESSOR_OLLAMA_CHAT_MODEL`, `DOCUMENT_PROCESSOR_OLLAMA_EMBED_MODEL`, `EVENT_BUS_NAME` (default `default`).

O security group da task precisa conseguir falar com o Ollama (mesma VPC ou rota privada). CPU/memória default maiores que o scraper (PDF + LLM por chunk).

Evento ao terminar: `DocumentProcessingCompleted` no EventBridge (`DetailType: DomainEvent`), para encadear notifiers ou métricas.

## services/process-edital-service (ECS Fargate)

Replica o comportamento do script `api:process-edital-info`, mas como **task Fargate agendada**: lê `documents`/`edital_pdfs`, chama o Ollama (`/api/generate`) para extrair campos e atualiza a tabela `editais` (inclui `informacoes_processadas_em`).

### Deploy

Tudo via **GitHub Actions** (`deploy-process-edital-service.yml`): build/push para ECR `origemlab-process-edital-service` e `aws cloudformation deploy` usando `infrastructure/ecs-process-edital-service.yml`.

Variáveis de repositório necessárias:

| Variável | Descrição |
|----------|-----------|
| `PROCESS_EDITAL_STACK_NAME` | Nome do stack CloudFormation |
| `PROCESS_EDITAL_VPC_ID` | VPC da task |
| `PROCESS_EDITAL_SUBNET_IDS` | IDs de subnet separados por vírgula |
| `PROCESS_EDITAL_SECURITY_GROUP_IDS` | Security groups separados por vírgula |
| `PROCESS_EDITAL_SUPABASE_SECRET_ARN` | ARN do secret no Secrets Manager (JSON: `url`, `service_role_key`) |
| `PROCESS_EDITAL_OLLAMA_BASE_URL` | URL interna do Ollama (`http://...:11434`) |

Opcionais: `PROCESS_EDITAL_SCHEDULE_EXPRESSION`, `PROCESS_EDITAL_CLUSTER_NAME`, `PROCESS_EDITAL_OLLAMA_MODEL`, `PROCESS_EDITAL_OLLAMA_TIMEOUT_MS`, `PROCESS_EDITAL_OLLAMA_MAX_CONTEXT_CHARS`, `PROCESS_EDITAL_LIMIT`, `PROCESS_EDITAL_DELAY_BETWEEN_EDITAIS_MS`.

## services/validate-edital-service (ECS Fargate)

Replica o comportamento do script `api:validate-editais-corretos`: valida (e corrige) campos extraídos usando o Ollama e faz upsert em `editais_corretos` quando o edital está “apresentável” para o site (link válido, resumo mínimo e prazo parseável).

### Deploy

Tudo via **GitHub Actions** (`deploy-validate-edital-service.yml`): build/push para ECR `origemlab-validate-edital-service` e `aws cloudformation deploy` usando `infrastructure/ecs-validate-edital-service.yml`.

Variáveis de repositório necessárias:

| Variável | Descrição |
|----------|-----------|
| `VALIDATE_EDITAL_STACK_NAME` | Nome do stack CloudFormation |
| `VALIDATE_EDITAL_VPC_ID` | VPC da task |
| `VALIDATE_EDITAL_SUBNET_IDS` | IDs de subnet separados por vírgula |
| `VALIDATE_EDITAL_SECURITY_GROUP_IDS` | Security groups separados por vírgula |
| `VALIDATE_EDITAL_SUPABASE_SECRET_ARN` | ARN do secret no Secrets Manager (JSON: `url`, `service_role_key`) |
| `VALIDATE_EDITAL_OLLAMA_BASE_URL` | URL interna do Ollama (`http://...:11434`) |

Opcionais: `VALIDATE_EDITAL_SCHEDULE_EXPRESSION`, `VALIDATE_EDITAL_CLUSTER_NAME`, `VALIDATE_EDITAL_OLLAMA_MODEL`, `VALIDATE_EDITAL_OLLAMA_TIMEOUT_MS`, `VALIDATE_EDITAL_OLLAMA_MAX_CONTEXT_CHARS`, `VALIDATE_EDITAIS_LIMIT`, `VALIDATE_EDITAIS_BATCH`, `VALIDATE_API_REQUEST_DELAY_MS`, `VALIDATE_DELAY_BETWEEN_EDITAIS_MS`, `VALIDATE_FORCE_REVALIDATE`.

## telegram-notifier

Env:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Build local:

```bash
cd origemlab-services
go test ./...
GOOS=linux GOARCH=amd64 go build -o bootstrap ./cmd/telegram-notifier
```

## error-reporter

Envia apenas severidade `error|fatal`.

Env:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (fallback)
- `TELEGRAM_ERROR_CHAT_ID` (opcional)

Build local:

```bash
cd origemlab-services
go test ./...
GOOS=linux GOARCH=amd64 go build -o bootstrap ./cmd/error-reporter
```

## Deploy (SAM)

Pré-req: `sam` e credenciais AWS.

```bash
cd origemlab-services
make sam-build
sam build
sam deploy --guided
```

Secrets esperados (exemplo):

- `origemlab/telegram` com chaves `bot_token`, `chat_id` e opcional `error_chat_id`.

