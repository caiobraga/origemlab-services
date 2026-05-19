# Serviços (`origemlab-services/services`)

Node.js (e TypeScript onde indicado) que correm fora do SAM: scrapers, processamento de PDFs e workers de extração/validação com Ollama e Supabase.

Cada pasta tem o seu **README** com comandos, variáveis de ambiente e notas de deploy. Para **IAM OIDC**, variáveis do GitHub e stacks CloudFormation partilhados, ver o [README do repositório](../README.md).

| Serviço | Função | Stack / workflow (referência) |
|--------|--------|-------------------------------|
| [scraper-runner](./scraper-runner/README.md) | Scrapes por fonte (FINEP, FAPs, etc.) → Supabase + EventBridge | `deploy-scraper-runner.yml`, `infrastructure/ecs-scraper-runner.yml` |
| [document-processor](./document-processor/README.md) | PDF → chunks → enriquecimento (Ollama) → `documents` + embeddings | `deploy-document-processor.yml`, `infrastructure/ecs-document-processor.yml` |
| [process-edital-service](./process-edital-service/README.md) | Extração de campos dos editais (Ollama) com contexto por chunks | `deploy-process-edital-service.yml`, `infrastructure/ecs-process-edital-service.yml` |
| [validate-edital-service](./validate-edital-service/README.md) | Validação/auditoria de editais com Ollama | `deploy-validate-edital-service.yml`, `infrastructure/ecs-validate-edital-service.yml` |
| [ollama-server](./ollama-server/README.md) | **Infra:** EC2 + Elastic IP + Ollama (IP fixo; modelos via GitHub/SSM) | `deploy-ollama-server.yml`, `infrastructure/ec2-ollama-server.yml` |

**Variáveis partilhadas:** o ficheiro [`../.env.example`](../.env.example) descreve `SUPABASE_*`, tuning do scraper, Ollama e flags dos workers. Em geral copias `../.env` na raiz do repo e corres a partir da pasta do serviço (os loaders apontam para `../../.env` quando aplicável).
