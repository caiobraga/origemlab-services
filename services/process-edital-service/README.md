# process-edital-service

Replica o fluxo do script **`api:process-edital-info`**: percorre editais no Supabase, usa contexto por **chunks**/`documents` (incl. top‑k por **`embedding`** ou **`embedding_perguntas`**), chama **Ollama** (`/api/generate`) para preencher campos em falta e grava em **`editais`** (incl. `informacoes_extracao_evidence` quando aplicável).

## Requisitos

- Node **≥ 20**
- `npm install` instala `tsx` para o script de entrada

## Configuração

- **Obrigatório:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OLLAMA_BASE_URL` (no ECS vêm do CloudFormation / secrets).
- **Notificações (AWS):** após cada gravação bem-sucedida ou falha, o serviço emite `DomainEvent` no EventBridge (`EVENT_BUS_NAME`, default `default`) — Telegram (todos) e error-reporter (`severity: error`). Local: `DISABLE_EVENTBRIDGE=1`.
- **Erros comuns:** `fetch failed` no Ollama → URL/rede/retries (`OLLAMA_FETCH_RETRIES`); `statement timeout` em `documents` → limites `PROCESS_EDITAL_DOCUMENTS_*` + índices em `sql/20260516_documents_edital_lookup_indexes.sql`.
- **Timeouts:** `OLLAMA_GENERATE_TIMEOUT_MS` (no ECS default **900000** = 15 min) aplica-se só ao `/api/generate`; `OLLAMA_EMBED_TIMEOUT_MS` ao embed. Se o log mostrar `timed out after 240000ms`, o task ainda usa `OLLAMA_TIMEOUT_MS=240000` global — redeploy com `PROCESS_EDITAL_OLLAMA_GENERATE_TIMEOUT_MS=900000` ou sobe `OLLAMA_TIMEOUT_MS`. Editais com **500k+ chars** usam janelas adaptativas (menos chamadas ao modelo).
- **Gravação parcial:** Se o erro (ex. timeout) ocorrer **a meio** do loop de campos, o serviço tenta **`update`** com os campos **já** extraídos (`⚠️ Gravação parcial` no log), para não perder trabalho antes de um `✅ atualizado`.
- Ordenação por volume de chunks: RPC `process_edital_editais_com_document_chunks` — aplicar `sql/20260513_process_edital_editais_com_document_chunks.sql` ou `PROCESS_EDITAL_SKIP_CHUNK_ORDER_RPC=1` para desligar temporariamente.

Mais opções: bloco **process-edital-service** em [`.env.example`](../../.env.example).

## Correr localmente

```bash
cd origemlab-services/services/process-edital-service
npm install
npm run start
```

O entrypoint é `src/api/processEditalInfo.ts` (carrega `../load-env` → `.env` na raiz do repo e `.env` local).

## Deploy (AWS)

`deploy-process-edital-service.yml` → ECR `origemlab-process-edital-service` + `infrastructure/ecs-process-edital-service.yml`. Variáveis e modo **continuous** vs **scheduled**: [README do repositório](../../README.md).

**Modelo Ollama no ECS:** o workflow envia sempre o parâmetro `OllamaModel` ao CloudFormation. Ordem: variável **`PROCESS_EDITAL_OLLAMA_MODEL`** (só este serviço) → senão **`OLLAMA_MODEL`** → senão default do template (`qwen2.5:14b`). Se definiste só `PROCESS_EDITAL_OLLAMA_MODEL` no GitHub, antes o deploy ignorava e deixava o default; garante também `ollama pull` do modelo no host.
