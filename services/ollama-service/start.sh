#!/bin/sh
set -eu
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}"
export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-2}"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-24h}"

echo "Starting ollama serve on ${OLLAMA_HOST} (num_parallel=${OLLAMA_NUM_PARALLEL} max_loaded=${OLLAMA_MAX_LOADED_MODELS} keep_alive=${OLLAMA_KEEP_ALIVE})"
ollama serve &
OLLAMA_PID=$!

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

CHAT="${OLLAMA_CHAT_MODEL:-gemma2:2b}"
EMBED="${OLLAMA_EMBED_MODEL:-mxbai-embed-large}"

# Ollama pull usa nome sem :latest; a API aceita com ou sem tag.
chat_pull="${CHAT%%:latest}"
embed_pull="${EMBED%%:latest}"

model_listed() {
  base="$1"
  curl -sf "http://127.0.0.1:11434/api/tags" | grep -q "\"name\":\"${base}"
}

pull_required() {
  name="$1"
  attempt=1
  while [ "${attempt}" -le 3 ]; do
    echo "Pulling ${name} (attempt ${attempt}/3)..."
    if ollama pull "${name}"; then
      if model_listed "${name}"; then
        echo "Model ready: ${name}"
        return 0
      fi
      echo "WARN: pull ${name} ok but not in /api/tags yet"
    else
      echo "WARN: ollama pull ${name} failed (attempt ${attempt})"
    fi
    attempt=$((attempt + 1))
    sleep 15
  done
  echo "ERROR: required model ${name} not available after 3 pull attempts"
  return 1
}

warm_chat_model() {
  name="$1"
  echo "Warming chat model ${name} (load weights into RAM)..."
  if curl -sf -X POST "http://127.0.0.1:11434/api/generate" \
    -H "content-type: application/json" \
    -d "{\"model\":\"${name}\",\"prompt\":\"ok\",\"stream\":false,\"options\":{\"num_predict\":8}}" >/dev/null; then
    echo "Warm-up generate ok: ${name}"
    return 0
  fi
  echo "WARN: warm-up generate failed for ${name} (continuing anyway)"
  return 0
}

if [ -n "${chat_pull}" ]; then
  pull_required "${chat_pull}" || exit 1
  warm_chat_model "${CHAT}"
fi
if [ -n "${embed_pull}" ] && [ "${embed_pull}" != "${chat_pull}" ]; then
  pull_required "${embed_pull}" || exit 1
fi

echo "Ollama ready — chat=${chat_pull} embed=${embed_pull}"
wait "${OLLAMA_PID}"
