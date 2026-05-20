# Ollama como serviço ECS (recomendado)

Endpoint **estável** (DNS do Network Load Balancer), sempre ligado, como um “banco de dados” de IA — sem EC2, Elastic IP nem SSH.

| Item | Valor |
|------|--------|
| Stack | `infrastructure/ecs-ollama-service.yml` |
| Workflow | `.github/workflows/deploy-ollama-service.yml` |
| ECR | `origemlab-ollama-service` |
| Stack default | `origemlab-ollama-service` |
| Cluster ECS | `origemlab-ollama` |

## IAM (obrigatório no papel `GithubActions`)

O deploy cria **Network Load Balancer** + target group e reutiliza **`SECURITY_GROUP_IDS`** (não cria SG novo). Sem permissões ELB/EC2 o CloudFormation falha com **AccessDenied**.

Anexe ao role `AWS_ROLE_ARN` o JSON em [`.github/aws-iam-policy-github-actions-elb.json`](../../.github/aws-iam-policy-github-actions-elb.json) (ELB + `ec2:AuthorizeSecurityGroupIngress` para abrir a porta 11434).

Se não puder alterar IAM: abra manualmente no console **EC2 → Security Groups** (primeiro ID de `SECURITY_GROUP_IDS`) → inbound **TCP 11434** da VPC e, se precisar dev local, do seu IP ou `0.0.0.0/0`.

## Variáveis GitHub

| Variável | Obrigatória | Default |
|----------|-------------|---------|
| `VPC_ID` | sim | — |
| `SUBNET_IDS` | sim | subnets **públicas** (tasks com IP público para pull de imagem/modelos) |
| `SECURITY_GROUP_IDS` | sim | mesmo das pipelines; o stack abre **11434** no primeiro SG da lista |
| `OLLAMA_BASE_URL` | sim (outros serviços) | output `OllamaBaseUrl` após deploy |
| `OLLAMA_CHAT_MODEL` | não | `gemma2:2b` |
| `OLLAMA_EMBED_MODEL` | não | `mxbai-embed-large:latest` |
| `OLLAMA_SERVICE_STACK_NAME` | não | `origemlab-ollama-service` |
| `OLLAMA_SERVER_PUBLIC_ACCESS_CIDR` | não | `0.0.0.0/0` (reutilizada para SG da porta 11434) |
| `OLLAMA_SERVICE_TASK_CPU` | não | `4096` |
| `OLLAMA_SERVICE_TASK_MEMORY` | não | `8192` |
| `OLLAMA_SERVICE_NLB_SCHEME` | não | `internet-facing` (`internal` só VPC) |

## Depois do deploy

1. Copie o output **`OllamaBaseUrl`** (produção atual: `http://origemlab-ollama-nlb-312422980eebe2d0.elb.us-east-1.amazonaws.com:11434`).
2. Defina **`OLLAMA_BASE_URL`** no GitHub (backend + services) e em `.env` local.
3. Apague o stack EC2 antigo **`origemlab-ollama`** se ainda existir (evita custo duplicado).

## Testar

```bash
curl -s "http://<NLB-DNS>:11434/api/tags" | head
```

O primeiro deploy demora vários minutos (`ollama pull` no container). Logs: CloudWatch `/origemlab/ollama-service`.

## EC2 legado

A abordagem anterior (`services/ollama-server`, `deploy-ollama-server.yml`) continua disponível só via **workflow_dispatch** manual.
