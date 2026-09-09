# document-processor

Processa PDFs em `edital_pdfs`: descarrega, extrai texto, divide em **chunks**, opcionalmente **enriquece** cada chunk (OpenRouter ou Ollama), grava em **`documents`** e gera **`embedding`** (texto completo do chunk) e **`embedding_perguntas`** (cabeçalho até “Perguntas exemplo”, para top‑k no process-edital). Opcionalmente emite **`DocumentProcessingCompleted`** no EventBridge.

## Requisitos

- Node **≥ 20**
- **Supabase** + provedor de IA: **OpenRouter** (`AI_PROVIDER=openrouter`, default) ou **Ollama** (`AI_PROVIDER=ollama`)

## Configuração

Ver bloco **document-processor** em [`.env.example`](../../.env.example):

- OpenRouter: `OPENROUTER_API_KEY`, `OPENROUTER_CHAT_MODEL`, `OPENROUTER_EMBED_MODEL=baai/bge-m3`, `EMBED_DIMENSIONS=1024`
- Ollama (emergência): `OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`
- Chunks: `CHUNK_SIZE`, `CHUNK_OVERLAP`, `ENRICH_CHUNKS`, `DOCUMENT_PROCESSOR_EMBED_PERGUNTAS`

Migração para a segunda coluna de embedding: `sql/20260513_documents_embedding_perguntas.sql`.

## Re-embed após cutover OpenRouter

Após deploy com `AI_PROVIDER=openrouter` e `baai/bge-m3` (1024-d), **reconstrua** embeddings para não misturar vetores antigos (Ollama) com novos:

```bash
cd origemlab-services/services/document-processor
# Reprocessa todos os PDFs (apaga chunks e re-embed)
AI_PROVIDER=openrouter OPENROUTER_API_KEY=… npm run start -- --rebuild --all
# Ou só preenche embedding_perguntas em linhas já existentes:
AI_PROVIDER=openrouter OPENROUTER_API_KEY=… npm run backfill:embedding-perguntas
```

Spot-check: dimensão 1024 e top-k num edital conhecido.

Também: [`docs/OPENROUTER_CUTOVER.md`](../../docs/OPENROUTER_CUTOVER.md).

## Correr localmente

```bash
cd origemlab-services/services/document-processor
npm install
AI_PROVIDER=openrouter OPENROUTER_API_KEY=… npm run start -- --limit=2
# ou emergência Ollama:
AI_PROVIDER=ollama OLLAMA_BASE_URL=http://localhost:11434 npm run start -- --limit=2
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

`deploy-document-processor.yml` → ECR `origemlab-document-processor` + stack `infrastructure/ecs-document-processor.yml`. Detalhes e variáveis GitHub: [README do repositório](../../README.md) (secção document-processor). Secret `OPENROUTER_API_KEY`; vars `AI_PROVIDER`, `OPENROUTER_*`, `EMBED_DIMENSIONS`.
