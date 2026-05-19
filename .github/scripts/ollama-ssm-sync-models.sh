#!/usr/bin/env bash
# Atualiza /opt/origemlab/ollama-models.env e faz ollama pull na instância Ollama (SSM Run Command).
set -euo pipefail

STACK_NAME=""
CHAT_MODEL=""
EMBED_MODEL=""
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"

usage() {
  echo "Usage: $0 --stack-name NAME --chat-model MODEL --embed-model MODEL" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --chat-model) CHAT_MODEL="$2"; shift 2 ;;
    --embed-model) EMBED_MODEL="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "${STACK_NAME}" ] && [ -n "${CHAT_MODEL}" ] && [ -n "${EMBED_MODEL}" ] || usage

INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text 2>/dev/null || true)"

if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "None" ]; then
  echo "Stack ${STACK_NAME} has no InstanceId output yet (first deploy?). Skipping SSM sync."
  exit 0
fi

PING_STATUS="$(aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo "")"

if [ "${PING_STATUS}" != "Online" ]; then
  echo "Instance ${INSTANCE_ID} not Online in SSM yet (status=${PING_STATUS:-unknown}). Skipping model sync."
  exit 0
fi

# SSM Run Command — um comando por linha
CMD1="install -d -m 0755 /opt/origemlab"
CMD2="printf '%s\\n' 'OLLAMA_CHAT_MODEL=${CHAT_MODEL}' 'OLLAMA_EMBED_MODEL=${EMBED_MODEL}' > /opt/origemlab/ollama-models.env"
CMD3="ollama pull ${CHAT_MODEL}"
CMD4="[ '${EMBED_MODEL}' = '${CHAT_MODEL}' ] || ollama pull ${EMBED_MODEL}"
CMD5="systemctl restart ollama || true"
CMD6="curl -sf http://127.0.0.1:11434/api/tags && echo models-synced"

COMMAND_ID="$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "origemlab ollama pull models" \
  --parameters "commands=[\"${CMD1}\",\"${CMD2}\",\"${CMD3}\",\"${CMD4}\",\"${CMD5}\",\"${CMD6}\"]" \
  --query 'Command.CommandId' --output text)"

echo "SSM CommandId=${COMMAND_ID} on ${INSTANCE_ID}"
aws ssm wait command-executed --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" || true
aws ssm get-command-invocation --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' --output json
