# process-edital-service

Replica o fluxo do script **`api:process-edital-info`**: percorre editais no Supabase, usa contexto por **chunks**/`documents` (incl. top‑k por **`embedding`** ou **`embedding_perguntas`**), chama **Ollama** (`/api/generate`) para preencher campos em falta e grava em **`editais`** (incl. `informacoes_extracao_evidence` quando aplicável).

## Requisitos

- Node **≥ 20**
- `npm install` instala `tsx` para o script de entrada

## Configuração

- **Obrigatório:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OLLAMA_BASE_URL` (no ECS vêm do CloudFormation / secrets).
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
