# document-processor

Processa PDFs em `edital_pdfs`: descarrega, extrai texto, divide em **chunks**, opcionalmente **enriquece** cada chunk com Ollama (alinhado ao pipeline de extração de editais), grava em **`documents`** e gera **`embedding`** (texto completo do chunk) e **`embedding_perguntas`** (cabeçalho até “Perguntas exemplo”, para top‑k no process-edital). Opcionalmente emite **`DocumentProcessingCompleted`** no EventBridge.

## Requisitos

- Node **≥ 20**
- **Supabase** + **Ollama** (chat + embed) acessíveis a partir da máquina onde corres

## Configuração

Ver bloco **document-processor** em [`.env.example`](../../.env.example): `SUPABASE_*`, `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `ENRICH_CHUNKS`, `DOCUMENT_PROCESSOR_EMBED_PERGUNTAS`, etc.

Migração para a segunda coluna de embedding: `sql/20260513_documents_embedding_perguntas.sql`.

## Correr localmente

```bash
cd origemlab-services/services/document-processor
npm install
OLLAMA_BASE_URL=http://localhost:11434 npm run start -- --limit=2
```

**Flags úteis** (ver `parseArgs` em `src/main.mjs`):

| Flag | Efeito |
|------|--------|
| `--dry-run` | Não grava alterações |
| `--all` | Reprocessa mesmo já marcados como processados |
| `--rebuild` | Reconstrói chunks/embeddings conforme lógica atual |
| `--limit=N` | Máximo de PDFs a tratar nesta execução |
| `--backfill-embedding-perguntas` | Só preenche `embedding_perguntas` em linhas já existentes (requer coluna na BD) |

Simular o loop contínuo da task ECS: `ECS_WORKER_LOOP=1` (+ `WORKER_IDLE_MS_*` no `.env.example`).

## Deploy (AWS)

`deploy-document-processor.yml` → ECR `origemlab-document-processor` + stack `infrastructure/ecs-document-processor.yml`. Detalhes e variáveis GitHub: [README do repositório](../../README.md) (secção document-processor).
