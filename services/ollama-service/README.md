# Ollama como serviço ECS (recomendado)

Endpoint **estável** (DNS do Network Load Balancer), sempre ligado, como um “banco de dados” de IA — sem EC2, Elastic IP nem SSH.

| Item | Valor |
|------|--------|
| Stack | `infrastructure/ecs-ollama-service.yml` |
| Workflow | `.github/workflows/deploy-ollama-service.yml` |
| ECR | `origemlab-ollama-service` |
| Stack default | `origemlab-ollama-service` |
| Cluster ECS | `origemlab-ollama` |

## Variáveis GitHub

| Variável | Obrigatória | Default |
|----------|-------------|---------|
| `VPC_ID` | sim | — |
| `SUBNET_IDS` | sim | subnets **públicas** (tasks com IP público para pull de imagem/modelos) |
| `OLLAMA_BASE_URL` | sim (outros serviços) | output `OllamaBaseUrl` após deploy |
| `OLLAMA_CHAT_MODEL` | não | `qwen2.5:7b` |
| `OLLAMA_EMBED_MODEL` | não | `mxbai-embed-large:latest` |
| `OLLAMA_SERVICE_STACK_NAME` | não | `origemlab-ollama-service` |
| `OLLAMA_SERVER_PUBLIC_ACCESS_CIDR` | não | `0.0.0.0/0` (reutilizada para SG da porta 11434) |
| `OLLAMA_SERVICE_TASK_CPU` | não | `4096` |
| `OLLAMA_SERVICE_TASK_MEMORY` | não | `8192` |
| `OLLAMA_SERVICE_NLB_SCHEME` | não | `internet-facing` (`internal` só VPC) |

## Depois do deploy

1. Copie o output **`OllamaBaseUrl`** (ex. `http://origemlab-ollama-nlb-xxxxx.elb.us-east-1.amazonaws.com:11434`).
2. Defina **`OLLAMA_BASE_URL`** no GitHub (backend + services) e em `.env` local.
3. Apague o stack EC2 antigo **`origemlab-ollama`** se ainda existir (evita custo duplicado).

## Testar

```bash
curl -s "http://<NLB-DNS>:11434/api/tags" | head
```

O primeiro deploy demora vários minutos (`ollama pull` no container). Logs: CloudWatch `/origemlab/ollama-service`.

## EC2 legado

A abordagem anterior (`services/ollama-server`, `deploy-ollama-server.yml`) continua disponível só via **workflow_dispatch** manual.
