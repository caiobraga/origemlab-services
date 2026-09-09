#!/usr/bin/env bash
# Scale down / delete OrigemLab Ollama stacks after OpenRouter cutover.
# Usage:
#   bash scripts/teardown-ollama.sh --scale-only
#   bash scripts/teardown-ollama.sh --delete
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
OLLAMA_ECS_STACK="${OLLAMA_ECS_STACK:-origemlab-ollama-service}"
OLLAMA_EC2_STACK="${OLLAMA_EC2_STACK:-origemlab-ollama}"
SCALE_ONLY=0
DELETE=0

for arg in "$@"; do
  case "$arg" in
    --scale-only) SCALE_ONLY=1 ;;
    --delete) DELETE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "${SCALE_ONLY}" -eq 0 ] && [ "${DELETE}" -eq 0 ]; then
  echo "Pass --scale-only and/or --delete" >&2
  exit 1
fi

require_aws() {
  if ! aws sts get-caller-identity --region "${AWS_REGION}" >/dev/null 2>&1; then
    echo "AWS credentials missing or expired. Run: aws login  (or refresh SSO/profile)" >&2
    exit 1
  fi
}

stack_status() {
  local stack="$1"
  local out
  if ! out="$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${AWS_REGION}" \
    --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    if echo "${out}" | grep -qiE 'does not exist|ValidationError'; then
      echo "MISSING"
      return 0
    fi
    echo "${out}" >&2
    return 1
  fi
  echo "${out}"
}

scale_service_to_zero() {
  local stack="$1"
  local status
  status="$(stack_status "${stack}")" || exit 1
  if [ "${status}" = "MISSING" ] || [ "${status}" = "None" ]; then
    echo "Stack ${stack}: not found — skip"
    return 0
  fi
  echo "Stack ${stack}: ${status}"

  local cluster service
  cluster="$(aws cloudformation describe-stack-resources --stack-name "${stack}" --region "${AWS_REGION}" \
    --query "StackResources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId | [0]" --output text 2>/dev/null || true)"
  service="$(aws cloudformation describe-stack-resources --stack-name "${stack}" --region "${AWS_REGION}" \
    --query "StackResources[?ResourceType=='AWS::ECS::Service'].PhysicalResourceId | [0]" --output text 2>/dev/null || true)"

  if [ -n "${cluster}" ] && [ "${cluster}" != "None" ] && [ -n "${service}" ] && [ "${service}" != "None" ]; then
    local svc_name="${service##*/}"
    echo "Scaling ECS service ${svc_name} on ${cluster} → desiredCount=0"
    aws ecs update-service --cluster "${cluster}" --service "${svc_name}" --desired-count 0 --region "${AWS_REGION}" >/dev/null
  else
    echo "No ECS service found on ${stack} (EC2-only stack?) — skip scale"
  fi
}

require_aws

if [ "${SCALE_ONLY}" -eq 1 ] || [ "${DELETE}" -eq 1 ]; then
  scale_service_to_zero "${OLLAMA_ECS_STACK}"
fi

if [ "${DELETE}" -eq 1 ]; then
  echo "Deleting CloudFormation stacks (this removes NLB / EC2 / ECS)…"
  for stack in "${OLLAMA_ECS_STACK}" "${OLLAMA_EC2_STACK}"; do
    status="$(stack_status "${stack}")" || exit 1
    if [ "${status}" = "MISSING" ] || [ "${status}" = "None" ]; then
      echo "Stack ${stack}: already gone"
      continue
    fi
    echo "delete-stack ${stack}"
    aws cloudformation delete-stack --stack-name "${stack}" --region "${AWS_REGION}"
  done
  echo "Aguarde DELETE_COMPLETE no console. Remova OLLAMA_BASE_URL dos required checks no GitHub."
fi

echo "Done. See docs/OPENROUTER_CUTOVER.md and docs/COST_OPTIMIZATION.md."
