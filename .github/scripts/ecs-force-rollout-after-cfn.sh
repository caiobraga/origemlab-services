#!/usr/bin/env bash
# After a successful CloudFormation deploy, replace running ECS tasks with the new
# task definition (image + env). Without this, an old task can keep running for days.
set -euo pipefail

STACK_NAME="${1:?stack name required}"
ORCH="${2:-continuous}"
REGION="${AWS_REGION:-us-east-1}"
WAIT="${ECS_ROLLOUT_WAIT_STABLE:-1}"

if [ "${ORCH}" = "scheduled" ]; then
  echo "OrchestrationMode=scheduled — sem ECS Service 24/7; a próxima execução do Scheduler usa a task definition atualizada."
  exit 0
fi

cf_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text 2>/dev/null || true
}

CLUSTER="$(cf_output EcsClusterName)"
SERVICE="$(cf_output WorkerServiceName)"

if [ -z "${CLUSTER}" ] || [ "${CLUSTER}" = "None" ]; then
  echo "WARN: output EcsClusterName ausente no stack ${STACK_NAME} — rollout automático ignorado."
  exit 0
fi

if [ -z "${SERVICE}" ] || [ "${SERVICE}" = "None" ]; then
  echo "WARN: output WorkerServiceName ausente (modo continuous sem WorkerService?) — rollout ignorado."
  exit 0
fi

echo "ECS force new deployment: cluster=${CLUSTER} service=${SERVICE}"
aws ecs update-service \
  --cluster "${CLUSTER}" \
  --service "${SERVICE}" \
  --force-new-deployment \
  --region "${REGION}" \
  --no-cli-pager \
  --output json >/dev/null

if [ "${WAIT}" = "0" ] || [ "${WAIT}" = "false" ] || [ "${WAIT}" = "no" ]; then
  echo "ECS_ROLLOUT_WAIT_STABLE=${WAIT} — não aguardando services-stable (deploy iniciado)."
  exit 0
fi

echo "Aguardando serviço estabilizar (aws ecs wait services-stable, até ~10 min)..."
if aws ecs wait services-stable \
  --cluster "${CLUSTER}" \
  --services "${SERVICE}" \
  --region "${REGION}"; then
  echo "ECS service estável: ${SERVICE}"
else
  echo "WARN: services-stable falhou ou expirou — confira no console ECS; o rollout pode ainda estar em curso."
fi
