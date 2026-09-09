#!/usr/bin/env bash
# Re-embed all documents after OpenRouter cutover (1024-d).
# Requires: SUPABASE_*, OPENROUTER_API_KEY (or AI_PROVIDER=ollama + OLLAMA_*).
#
# Usage (from origemlab-services):
#   bash scripts/reembed-documents.sh
#   bash scripts/reembed-documents.sh --limit=5
#   bash scripts/reembed-documents.sh --perguntas-only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}/services/document-processor"

if [ -f "${ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/.env"
  set +a
fi

export AI_PROVIDER="${AI_PROVIDER:-openrouter}"
export EMBED_DIMENSIONS="${EMBED_DIMENSIONS:-1024}"
export OPENROUTER_EMBED_MODEL="${OPENROUTER_EMBED_MODEL:-baai/bge-m3}"
export OPENROUTER_CHAT_MODEL="${OPENROUTER_CHAT_MODEL:-qwen/qwen-2.5-7b-instruct}"

if [ "${AI_PROVIDER}" = "openrouter" ]; then
  : "${OPENROUTER_API_KEY:?Set OPENROUTER_API_KEY}"
fi
: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY}"

PERGUNTAS_ONLY=0
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --perguntas-only) PERGUNTAS_ONLY=1 ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

if [ ! -d node_modules ]; then
  npm ci
fi

if [ "${PERGUNTAS_ONLY}" -eq 1 ]; then
  echo "Backfill embedding_perguntas only…"
  npm run start -- --backfill-embedding-perguntas "${EXTRA_ARGS[@]}"
else
  echo "Full rebuild + re-embed (OpenRouter ${OPENROUTER_EMBED_MODEL}, dims=${EMBED_DIMENSIONS})…"
  npm run start -- --rebuild --all "${EXTRA_ARGS[@]}"
fi
