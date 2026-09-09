# Append OpenRouter (and optional Ollama) CloudFormation overrides to OVERRIDES.
# Source after OVERRIDES=(...) is defined. Expects bash + set -u compatible callers.
#
# Env:
#   AI_PROVIDER              default openrouter (openrouter|ollama)
#   OPENROUTER_API_KEY       required when AI_PROVIDER=openrouter
#   OPENROUTER_CHAT_MODEL    default qwen/qwen-2.5-7b-instruct
#   OPENROUTER_EMBED_MODEL   default baai/bge-m3
#   EMBED_DIMENSIONS         default 1024
#   OLLAMA_BASE_URL          required when AI_PROVIDER=ollama; optional otherwise

_ai_provider="$(printf '%s' "${AI_PROVIDER:-openrouter}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
_ai_provider="${_ai_provider:-openrouter}"
case "${_ai_provider}" in
  openrouter|ollama) ;;
  *)
    echo "::error::AI_PROVIDER must be openrouter or ollama (got: ${_ai_provider})"
    exit 1
    ;;
esac

OVERRIDES+=("AiProvider=${_ai_provider}")

if [ "${_ai_provider}" = "openrouter" ]; then
  : "${OPENROUTER_API_KEY:?Set repo secret OPENROUTER_API_KEY (required when AI_PROVIDER=openrouter)}"
  OVERRIDES+=("OpenRouterApiKey=${OPENROUTER_API_KEY}")
else
  : "${OLLAMA_BASE_URL:?Set repo variable OLLAMA_BASE_URL (required when AI_PROVIDER=ollama)}"
fi

if [ -n "${OLLAMA_BASE_URL:-}" ]; then
  OVERRIDES+=("OllamaBaseUrl=${OLLAMA_BASE_URL}")
fi

_chat="$(printf '%s' "${OPENROUTER_CHAT_MODEL:-qwen/qwen-2.5-7b-instruct}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
_embed="$(printf '%s' "${OPENROUTER_EMBED_MODEL:-baai/bge-m3}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
_dims="$(printf '%s' "${EMBED_DIMENSIONS:-1024}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[[ "${_dims}" =~ ^[0-9]+$ ]] || _dims=1024

OVERRIDES+=("OpenRouterChatModel=${_chat}")
OVERRIDES+=("OpenRouterEmbedModel=${_embed}")
OVERRIDES+=("EmbedDimensions=${_dims}")

unset _ai_provider _chat _embed _dims
