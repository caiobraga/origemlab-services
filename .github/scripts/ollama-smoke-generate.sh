#!/usr/bin/env bash
# Smoke test: /api/tags + /api/generate latency (use após deploy do ollama-service).
set -euo pipefail
BASE="${1:-${OLLAMA_BASE_URL:-http://127.0.0.1:11434}}"
BASE="${BASE%/}"
MODEL="${2:-gemma2:2b}"
MAX_SEC="${3:-120}"

echo "Ollama base: ${BASE}"
echo "Model: ${MODEL}"
curl -sf "${BASE}/api/tags" | head -c 400
echo ""
echo "--- generate (num_predict=16) ---"
START=$(date +%s)
if curl -sf --max-time "${MAX_SEC}" -X POST "${BASE}/api/generate" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"prompt\":\"JSON: {\\\"ok\\\":true}\",\"stream\":false,\"options\":{\"num_predict\":16,\"temperature\":0}}"; then
  END=$(date +%s)
  echo ""
  echo "OK em $((END - START))s (meta: <30s saudável, >90s = subir CPU/RAM ou OLLAMA_KEEP_ALIVE)"
else
  echo "FAIL: timeout ${MAX_SEC}s ou erro de rede"
  exit 1
fi
