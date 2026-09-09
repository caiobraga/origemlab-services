# OpenRouter cutover (Phase A)

Chat + embeddings via OpenRouter; backend permanece no Elastic Beanstalk; pipelines no ECS.
Dimensão de embedding: **1024** (`baai/bge-m3` + `EMBED_DIMENSIONS=1024`).

## Variáveis

| Var | Onde | Notas |
|-----|------|--------|
| `OPENROUTER_API_KEY` | GitHub **secret** (backend + origemlab-services) | Obrigatório |
| `AI_PROVIDER` | GitHub var | `openrouter` (default) ou `ollama` |
| `OPENROUTER_CHAT_MODEL` | GitHub var | default `qwen/qwen-2.5-7b-instruct` |
| `OPENROUTER_EMBED_MODEL` | GitHub var | default `baai/bge-m3` |
| `EMBED_DIMENSIONS` | GitHub var | `1024` |
| `OLLAMA_BASE_URL` | GitHub var | Só se `AI_PROVIDER=ollama` |

## Ordem de rollout

1. Definir secrets/vars no GitHub (backend + services).
2. Deploy backend (EB) + smoke: `/api/edital-chat`, field AI.
3. Deploy `unified-pipeline` (ou document-processor / edital-pipeline legados).
4. **Re-embed** todos os documentos (ver abaixo).
5. Scale-to-0 / apagar Ollama ECS+NLB (ver `scripts/teardown-ollama.sh`).
6. Monitorar gasto OpenRouter e erros Auth/API.

## Re-embed

Não misture vetores Ollama e OpenRouter no mesmo índice:

```bash
cd services/document-processor
AI_PROVIDER=openrouter OPENROUTER_API_KEY=… \
  npm run start -- --rebuild --all
```

Spot-check: comprimento 1024; retrieval top-k sensato num edital conhecido.

## Tear down Ollama

```bash
bash scripts/teardown-ollama.sh --scale-only   # DesiredCount=0
bash scripts/teardown-ollama.sh --delete       # apaga stacks (confirma)
```

Stacks típicos: `origemlab-ollama-service`, legado `origemlab-ollama` (EC2).

## Cloudflare migration (full stack)

Após deploy de Workers + Pages, configure secrets via `wrangler secret put` (ver [`cloudflare/README.md`](../../cloudflare/README.md)).
Re-embed pós-cutover: `bash cloudflare/scripts/reembed-after-cutover.sh` ou document-processor `--rebuild --all`.
Checklist DNS/smoke/AWS: [`cloudflare/docs/CUTOVER.md`](../../cloudflare/docs/CUTOVER.md).
