#!/bin/sh
set -eu
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"

echo "Starting ollama serve on ${OLLAMA_HOST}"
ollama serve &
OLLAMA_PID=$!

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

CHAT="${OLLAMA_CHAT_MODEL:-qwen2.5:7b}"
EMBED="${OLLAMA_EMBED_MODEL:-mxbai-embed-large:latest}"

if [ -n "${CHAT}" ]; then
  echo "Pulling chat model: ${CHAT}"
  ollama pull "${CHAT}" || true
fi
if [ -n "${EMBED}" ] && [ "${EMBED}" != "${CHAT}" ]; then
  echo "Pulling embed model: ${EMBED}"
  ollama pull "${EMBED}" || true
fi

echo "Ollama ready"
wait "${OLLAMA_PID}"
