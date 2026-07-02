# Otimização de custos AWS — OrigemLab

Guia prático para reduzir gastos sem perder funcionalidade. Estimativas em **us-east-1** (ordem de grandeza, 2026).

## Diagnóstico rápido (console AWS)

Execute este checklist **hoje**:

| O que verificar | Onde | Ação se estiver ligado |
|-----------------|------|------------------------|
| Stacks legados ECS | CloudFormation → `origemlab-document-processor`, `scraper-runner`, `process-edital`, `validate-edital` | **Apagar** ou Desired count = 0 |
| EC2 Ollama legado | Stack `origemlab-ollama` | **Apagar** (duplica o ECS Ollama) |
| Edital pipeline 24/7 | ECS → `origemlab-edital-pipeline` → Services com Desired=1 | Mudar para `scheduled` (ver abaixo) |
| Ollama oversized | ECS → task 8 vCPU / 16 GB | Testar 4 vCPU / 8 GB |
| EB oversized | Elastic Beanstalk → Configuration → Capacity | t3.small ou t4g.small costuma bastar |
| CloudFront API | Distribuição extra só para API | Remover se EB já tem HTTPS |

```bash
# Listar stacks OrigemLab
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?contains(StackName,'origemlab')].StackName" --output table

# Ver serviços ECS com tasks sempre ligadas
for c in origemlab-ollama origemlab-edital-pipeline origemlab-ingestion-pipeline; do
  echo "=== $c ==="
  aws ecs list-services --cluster "$c" --output text 2>/dev/null || true
done
```

---

## Arquitetura alvo (menor custo)

```
S3 + CloudFront (front)          ~$5–15/mês
Elastic Beanstalk (API)          ~$15–35/mês  (t3.small)
Ollama ECS Fargate 4vCPU/8GB     ~$120–150/mês  (24/7 — maior custo fixo)
NLB (Ollama)                     ~$20–25/mês
unified-pipeline (scheduled)     ~$35–90/mês  (4 fases numa task; sem overlap)
Lambda (Telegram)                ~$1/mês
Supabase (externo)               variável
─────────────────────────────────────────────
Total AWS estimado               ~$180–320/mês
```

**Princípio:** só o **Ollama** fica 24/7. O **unified-pipeline** roda as 4 fases em sequência num único schedule.

---

## Ações por impacto

### 1. Unified pipeline (substitui ingestion + edital separados)

**Problema:** dois stacks scheduled podiam rodar ao mesmo tempo e saturar o Ollama.

**Solução:** `unified-pipeline-service` — um container, quatro fases, um schedule.

- Stack: `origemlab-unified-pipeline` (default)
- `UNIFIED_PIPELINE_ORCHESTRATION_MODE=scheduled`
- `UNIFIED_PIPELINE_SCHEDULE_EXPRESSION=rate(1 hour)`

Após deploy, **apague** `origemlab-ingestion-pipeline` e `origemlab-edital-pipeline`.

---

### 2. Edital pipeline separado (legado): `continuous` → `scheduled`

**Problema:** `OrchestrationMode=continuous` mantém 1 task Fargate (2 vCPU / 4 GB) rodando 24/7 mesmo quando a fila está vazia (`WORKER_IDLE_MS_NO_WORK=120s`).

**Solução (já é o default no código):**

- GitHub → Settings → Actions → Variables:
  - `EDITAL_PIPELINE_ORCHESTRATION_MODE` = `scheduled`
  - `EDITAL_PIPELINE_SCHEDULE_EXPRESSION` = `rate(1 hour)` (ou `rate(30 minutes)` se precisar mais frequência)
- Redeploy: Actions → *deploy-all-ecs-services*

Entre execuções: **0 tasks** no cluster — normal e desejado.

Para processar mais rápido sem voltar ao 24/7: aumente a frequência do schedule, não o DesiredCount.

---

### 2. Ollama: right-size CPU/RAM (economia ~$100–150/mês)

**Problema:** default era 8 vCPU / 16 GB para `gemma2:2b` — modelo pequeno; metade dos recursos costuma bastar.

**Solução:**

| Variável GitHub | Antes | Depois (testar) |
|-----------------|-------|-----------------|
| `OLLAMA_SERVICE_TASK_CPU` | 8192 | **4096** |
| `OLLAMA_SERVICE_TASK_MEMORY` | 16384 | **8192** |

Redeploy Ollama. Rode `ollama-smoke-generate.sh`. Se generate > 90s ou OOM, suba para 6144/12288 ou volte a 8192/16384.

Outras otimizações Ollama:

- `OLLAMA_KEEP_ALIVE=5m` (já default) — libera RAM entre chat/embed
- `OLLAMA_MAX_LOADED_MODELS=1` — evita dois modelos em RAM
- `OLLAMA_SERVICE_NLB_SCHEME=internal` + só clientes na VPC (se EB/pipelines estão na mesma VPC)

---

### 3. Apagar stacks legados (economia variável, até $150+/mês)

Se ainda existirem após migrar para pipelines consolidados:

| Stack legado | Substituído por |
|--------------|-----------------|
| `origemlab-document-processor` | `origemlab-ingestion-pipeline` |
| `origemlab-scraper-runner` | ingestion-pipeline |
| `origemlab-process-edital-service` | `origemlab-edital-pipeline` |
| `origemlab-validate-edital-service` | edital-pipeline |
| `origemlab-ollama` (EC2) | `origemlab-ollama-service` (ECS) |

```bash
aws cloudformation delete-stack --stack-name origemlab-document-processor
# repetir para cada stack legado confirmado inativo
```

---

### 4. Elastic Beanstalk: instância menor

Não está no IaC — configure no console:

- **Environment → Configuration → Capacity**
- Instance type: `t3.small` ou `t4g.small` (ARM, mais barato)
- Min/Max instances: **1** (sem auto-scaling se tráfego é baixo)
- Remover CloudFront da API se só adiciona latência/custo (`cloudfront-api.yaml` é opcional)

---

### 5. Ingestion pipeline: ajustar frequência

Default `rate(1 hour)` — adequado para scrapers. Se editais não precisam de atualização horária:

- `INGESTION_PIPELINE_SCHEDULE_EXPRESSION` = `rate(6 hours)` ou `cron(0 6,18 * * ? *)` (2x/dia)

Custo proporcional ao tempo de execução da task (Puppeteer + PDF + LLM).

---

### 6. CloudFront (front)

- Invalidação `/*` a cada deploy cobra por path — prefira invalidar só `/index.html` e `/assets/*` se possível
- `PriceClass_100` já é o mais barato (só EUA/Europa)

---

### 7. Logs CloudWatch

Todos os stacks usam retenção **14 dias** — OK. Para economizar mais: 7 dias nos workers (`RetentionInDays` nos templates).

---

## Modo de operação recomendado

| Serviço | Modo | Motivo |
|---------|------|--------|
| Ollama ECS | 24/7 (right-sized) | API e pipelines precisam de endpoint estável |
| ingestion-pipeline | scheduled | scrape + PDF é batch |
| edital-pipeline | scheduled | validate + process é batch |
| Backend EB | 1 instância pequena | API REST leve |
| Lambdas | event-driven | só Telegram |

**Não usar `continuous`** em workers a menos que haja SLA de latência < 1h para novos editais.

---

## Variáveis GitHub (resumo custo-otimizado)

```env
# Pipelines — agendados
EDITAL_PIPELINE_ORCHESTRATION_MODE=scheduled
EDITAL_PIPELINE_SCHEDULE_EXPRESSION=rate(1 hour)
INGESTION_PIPELINE_SCHEDULE_EXPRESSION=rate(1 hour)

# Ollama — right-sized (ajustar se lento)
OLLAMA_SERVICE_TASK_CPU=4096
OLLAMA_SERVICE_TASK_MEMORY=8192
OLLAMA_KEEP_ALIVE=5m
OLLAMA_SERVICE_NLB_SCHEME=internal   # se toda a rede for VPC

# Segurança + custo: restringir acesso Ollama à VPC
OLLAMA_SERVER_PUBLIC_ACCESS_CIDR=       # vazio = só VPC
```

Para forçar 24/7 no edital (não recomendado por custo): `EDITAL_PIPELINE_ORCHESTRATION_MODE=continuous`.

---

## Próximos passos (fase 2 — maior economia, mais trabalho)

1. **Ollama on-demand:** subir task só quando pipeline agenda + desligar após idle (EventBridge + Lambda scaler) — economia de ~$120/mês mas +complexidade e cold start (~2–3 min pull modelos).
2. **Migrar LLM para API gerenciada** (Bedrock/OpenAI) para cargas esporádicas — elimina Ollama+NLB fixos.
3. **Fargate Spot** para tasks scheduled (não para Ollama 24/7).
4. **Um único ECS cluster** para todos os workers (não reduz $ direto, simplifica ops).

---

## Monitoramento de custo

- AWS Cost Explorer → filtrar por tag `Project=origemlab` (adicionar tags nos stacks se ainda não tiver)
- Budget alert em $300/mês
- Métrica: horas Fargate × vCPU — principal driver após Ollama
