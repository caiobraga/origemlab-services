# origemlab-services

Serviços (Lambda) consumindo eventos do EventBridge.

**Serviços Node/ECS** (scrapers e workers): índice em [`services/README.md`](services/README.md).

## IAM: papel OIDC do GitHub Actions (`AWS_ROLE_ARN`)

Os workflows que fazem `aws cloudformation deploy` nos templates **ECS Fargate** (`infrastructure/ecs-*.yml`) usam o **mesmo** papel que o SAM (`deploy.yml`). O CloudFormation chama a API ECS **com as credenciais desse papel**, não só com o `CAPABILITY_IAM` interno ao stack.

Se o deploy falhar com **AccessDenied** em `ecs:CreateService` (recurso `WorkerService`), o papel (ex.: `GithubActions`) precisa de permissões ECS além de CloudFormation/ECR. Exemplo de statement a **anexar** à política desse papel (ajuste `ACCOUNT_ID` e `REGION`; restrinja `Resource` se quiser menos superfície):

```json
{
  "Sid": "OrigemlabEcsCloudFormationDeploy",
  "Effect": "Allow",
  "Action": [
    "ecs:CreateCluster",
    "ecs:DeleteCluster",
    "ecs:DescribeClusters",
    "ecs:RegisterTaskDefinition",
    "ecs:DeregisterTaskDefinition",
    "ecs:DescribeTaskDefinition",
    "ecs:CreateService",
    "ecs:UpdateService",
    "ecs:DeleteService",
    "ecs:DescribeServices",
    "ecs:TagResource",
    "ecs:UntagResource",
    "ecs:DescribeServices",
    "ecs:ListTasks",
    "logs:CreateLogGroup",
    "logs:DeleteLogGroup",
    "logs:PutRetentionPolicy",
    "logs:DescribeLogGroups",
    "scheduler:CreateSchedule",
    "scheduler:DeleteSchedule",
    "scheduler:GetSchedule",
    "scheduler:UpdateSchedule"
  ],
  "Resource": "*"
}
```

Para stacks com `OrchestrationMode=scheduled`, o EventBridge Scheduler também precisa das ações `scheduler:*` acima. O SAM continua a precisar de Lambda, EventBridge (regras), S3 (artefatos), etc., conforme o comentário em `.github/workflows/deploy.yml`.

Após cada deploy CloudFormation bem-sucedido dos workers ECS (`continuous`), os workflows chamam `.github/scripts/ecs-force-rollout-after-cfn.sh`, que executa `ecs:UpdateService` com `--force-new-deployment` para substituir tasks antigas pela nova task definition (imagem + env). Sem isso, uma task pode continuar dias com código/modelo antigos mesmo após push no ECR.

## Ollama em EC2 (IP fixo) — **recomendado para IA**

Para um endpoint Ollama estável (`http://<Elastic-IP>:11434`) e troca de modelos só pelas variáveis GitHub (`OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `OLLAMA_MODEL`):

- Stack: `infrastructure/ec2-ollama-server.yml`
- Workflow: `.github/workflows/deploy-ollama-server.yml`
- Guia: [`services/ollama-server/README.md`](services/ollama-server/README.md)

Variáveis mínimas: `OLLAMA_SERVER_STACK_NAME`, `VPC_ID`, `OLLAMA_SERVER_SUBNET_ID`. Depois do deploy, defina **`OLLAMA_BASE_URL`** (output `OllamaBaseUrl`) no backend e nos workflows ECS. Cada push no workflow pode fazer `ollama pull` via SSM sem mudar o IP.

## services/ingestion-pipeline-service (ECS Fargate) — **recomendado (ingestão)**

Um único container executa em sequência **scraper-runner** → **document-processor** (imagem base Puppeteer + Chromium).

**Custo:** substitui o **document-processor contínuo** (24/7) + scraper agendado por **uma task agendada** (`OrchestrationMode=scheduled`, default `rate(1 hour)`).

### Deploy

`deploy-ingestion-pipeline-service.yml` → ECR `origemlab-ingestion-pipeline-service` + `infrastructure/ecs-ingestion-pipeline-service.yml`.

| Variável | Descrição |
|----------|-----------|
| `INGESTION_PIPELINE_STACK_NAME` | Stack CloudFormation |
| `VPC_ID`, `SUBNET_IDS`, `SECURITY_GROUP_IDS` | Rede |
| `OLLAMA_BASE_URL` | Ollama (fase document-processor) |
| `INGESTION_PIPELINE_SCHEDULE_EXPRESSION` | Opcional (default `rate(1 hour)`) |
| `ECS_ORCHESTRATION_MODE` | Opcional (default **`scheduled`**) |

Variáveis do scraper (`SCRAPER_*`, `NODE_DNS_IPV4FIRST`) e do document-processor (`OLLAMA_CHAT_MODEL`, `ENRICH_CHUNKS`, etc.) aplicam-se à mesma task.

### Migrar

1. Deploy do pipeline com `INGESTION_PIPELINE_STACK_NAME`.
2. **Desligar** o ECS Service `*-document-processor-worker` (Desired count = 0) ou apagar o stack antigo.
3. Opcional: remover stack `scraper-runner` se só usava o schedule (o scraper passa a correr dentro do pipeline).

Local: `cd services/ingestion-pipeline-service && npm i && npm run start`.

---

## services/scraper-runner (ECS Fargate) — legado

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

**Variáveis opcionais no GitHub** (Settings → Actions → Variables): `NODE_DNS_IPV4FIRST`, `SCRAPER_FETCH_RETRIES`, `SCRAPER_FETCH_CONNECT_TIMEOUT_MS`, `SCRAPER_FETCH_HEADERS_TIMEOUT_MS`, `SCRAPER_FETCH_BODY_TIMEOUT_MS`, `SCRAPER_SOURCE_TIMEOUT_MS`. Se não definidas, o workflow usa os mesmos defaults do `.env.example` (1, 4, 60000, 120000, 120000, 300000). Repassadas ao container via CloudFormation.

## services/document-processor (ECS Fargate) — legado

Processa `edital_pdfs` não marcados como processados: baixa o PDF do bucket `edital-pdfs`, extrai texto, divide em chunks e, **antes do embedding**, chama o Ollama (`/api/chat`) para gerar contexto alinhado ao pipeline **`api:process-edital-info`** (tipos de pergunta, campos relacionados, perguntas exemplo). O texto completo enriquecido vai para `documents.content` e para o vetor **`embedding`**; o cabeçalho até “Perguntas exemplo” (sem `[TRECHO DO EDITAL]`) é embedado em **`embedding_perguntas`** para o top-k no `process-edital-service`. Migração: `sql/20260513_documents_embedding_perguntas.sql`. Retrospetivo: `npm run backfill:embedding-perguntas` (no serviço document-processor).

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

Flags: `--dry-run`, `--all` (reprocessa mesmo com `is_processed`), `--limit=N`, `--backfill-embedding-perguntas` (só preenche `embedding_perguntas` em linhas já indexadas; requer coluna na base).

**AWS (default no template):** `OrchestrationMode=scheduled`. Preferir **ingestion-pipeline-service**. Modo contínuo legado: um **ECS Service** com `DesiredCount: 1` mantém a task ativa; o container roda com `ECS_WORKER_LOOP=1` e **repete o processamento** após cada lote, com pausa `WORKER_IDLE_MS_AFTER_WORK` / `WORKER_IDLE_MS_NO_WORK`. Para o modelo antigo (só EventBridge a intervalos), defina a variável de repositório `ECS_ORCHESTRATION_MODE=scheduled` no GitHub Actions (e mantenha `DOCUMENT_PROCESSOR_SCHEDULE_EXPRESSION`).

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

Opcionais: `ECS_ORCHESTRATION_MODE`, `WORKER_IDLE_MS_*`, `DOCUMENT_PROCESSOR_SCHEDULE_EXPRESSION`, `DOCUMENT_PROCESSOR_CLUSTER_NAME`, `DOCUMENT_PROCESSOR_OLLAMA_CHAT_MODEL`, `DOCUMENT_PROCESSOR_OLLAMA_EMBED_MODEL`, `DOCUMENT_PROCESSOR_EMBED_PERGUNTAS`, `EVENT_BUS_NAME` (default `default`).

O security group da task precisa conseguir falar com o Ollama (mesma VPC ou rota privada). CPU/memória default maiores que o scraper (PDF + LLM por chunk).

Evento ao terminar: `DocumentProcessingCompleted` no EventBridge (`DetailType: DomainEvent`), para encadear notifiers ou métricas.

## services/edital-pipeline-service (ECS Fargate) — **recomendado**

Um único container executa em sequência **process-edital-info** → **validate-editais-corretos**, substituindo **dois** ECS Services 24/7.

**Custo:** default `OrchestrationMode=scheduled` — só corre quando o EventBridge dispara (ex. `rate(1 hour)`), sem task Fargate sempre ligada.

### Deploy

`deploy-edital-pipeline-service.yml` → ECR `origemlab-edital-pipeline-service` + `infrastructure/ecs-edital-pipeline-service.yml`.

| Variável | Descrição |
|----------|-----------|
| `EDITAL_PIPELINE_STACK_NAME` | Stack CloudFormation (ex. `origemlab-edital-pipeline`) |
| `VPC_ID`, `SUBNET_IDS`, `SECURITY_GROUP_IDS` | Rede (partilhadas com outros serviços) |
| Secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `OLLAMA_BASE_URL` | Ollama |
| `EDITAL_PIPELINE_SCHEDULE_EXPRESSION` | Opcional (default `rate(1 hour)`) |
| `ECS_ORCHESTRATION_MODE` | Opcional (default **`scheduled`**) |

Variáveis de process/validate (`PROCESS_EDITAL_*`, `VALIDATE_*`, `OLLAMA_MODEL`, etc.) aplicam-se ao mesmo task definition.

### Migrar dos stacks antigos

1. Deploy do pipeline com `EDITAL_PIPELINE_STACK_NAME` e `ECS_ORCHESTRATION_MODE=scheduled`.
2. Nos stacks **process-edital** e **validate-edital** antigos: atualizar com `ECS_ORCHESTRATION_MODE=scheduled` **ou** apagar os ECS Services / stacks para parar cobrança 24/7.
3. `deploy-all-ecs-services` já só dispara o pipeline (os deploys separados ficam comentados).

Local: `cd services/edital-pipeline-service && npm i && npm run start` (`.env` na raiz `origemlab-services`).

---

## services/process-edital-service (ECS Fargate) — legado

Replica o comportamento do script `api:process-edital-info`, mas no **ECS Fargate**: percorre **todos** os editais (paginação Supabase), ordena por volume de chunks com texto em `documents` (RPC `process_edital_editais_com_document_chunks` — ver `sql/20260513_process_edital_editais_com_document_chunks.sql`), só chama Ollama para campos que ainda precisam de extração (`fieldNeedsExtraction`), lê `documents`/`edital_pdfs` só nesses casos e atualiza `editais`.

**AWS (default no template):** `OrchestrationMode=scheduled`. Para loop 24/7 (mais caro): `ECS_ORCHESTRATION_MODE=continuous`. Preferir **edital-pipeline-service**.

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

Opcionais: `ECS_ORCHESTRATION_MODE` (`continuous` \| `scheduled`), `WORKER_IDLE_MS_AFTER_WORK`, `WORKER_IDLE_MS_NO_WORK`, `PROCESS_EDITAL_SCHEDULE_EXPRESSION`, `PROCESS_EDITAL_CLUSTER_NAME`, **`OLLAMA_MODEL`** (modelo no container; usado em todos os serviços que partilham a variável), **`PROCESS_EDITAL_OLLAMA_MODEL`** (se definida, **substitui** `OLLAMA_MODEL` só neste deploy), `PROCESS_EDITAL_OLLAMA_TIMEOUT_MS`, `PROCESS_EDITAL_OLLAMA_MAX_CONTEXT_CHARS`, `PROCESS_EDITAL_LIMIT` (máx. itens por execução do lote), `PROCESS_EDITAL_FETCH_PAGE_SIZE`, `PROCESS_EDITAL_ORDER` (`pending_first` \| `documents_chunks_only` \| `criado_em_desc`), `PROCESS_EDITAL_SKIP_CHUNK_ORDER_RPC`, `PROCESS_EDITAL_TOPK_EMBEDDING` (`perguntas` \| `full`), `PROCESS_EDITAL_ONLY_ID`, `PROCESS_EDITAL_DELAY_BETWEEN_EDITAIS_MS`, **`PROCESS_EDITAL_CONCURRENCY`**, **`PROCESS_EDITAL_FIELD_CONCURRENCY`** (paralelismo por task; defaults 2).

## services/validate-edital-service (ECS Fargate) — legado

Replica o script `api:validate-editais-corretos` no ECS Fargate.

**AWS (default no template):** `OrchestrationMode=scheduled`. Preferir **edital-pipeline-service** (process + validate no mesmo container).

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

Opcionais: `ECS_ORCHESTRATION_MODE`, `WORKER_IDLE_MS_*`, `OLLAMA_EMBED_MODEL`, `VALIDATE_EDITAL_SCHEDULE_EXPRESSION`, `VALIDATE_EDITAL_CLUSTER_NAME`, `VALIDATE_EDITAL_OLLAMA_MODEL`, `VALIDATE_EDITAL_OLLAMA_TIMEOUT_MS`, `VALIDATE_EDITAL_OLLAMA_MAX_CONTEXT_CHARS`, `VALIDATE_EDITAIS_LIMIT`, `VALIDATE_EDITAIS_BATCH`, `VALIDATE_API_REQUEST_DELAY_MS`, `VALIDATE_DELAY_BETWEEN_EDITAIS_MS`, **`VALIDATE_EDITAL_CONCURRENCY`**, **`VALIDATE_FIELD_CONCURRENCY`** (defaults 2), `VALIDATE_FORCE_REVALIDATE`.

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

