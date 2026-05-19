#!/usr/bin/env bash
# Apaga stack em estado terminal (ex. ROLLBACK_COMPLETE) para permitir novo deploy.
set -euo pipefail

STACK_NAME="${1:?stack name required}"
REGION="${AWS_REGION:-us-east-1}"

if ! aws cloudformation describe-stacks --stack-name "${STACK_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Stack ${STACK_NAME} does not exist — nothing to delete."
  exit 0
fi

STATUS="$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query 'Stacks[0].StackStatus' \
  --output text)"

case "${STATUS}" in
  ROLLBACK_COMPLETE|CREATE_FAILED|ROLLBACK_FAILED|DELETE_FAILED)
    echo "Deleting stack ${STACK_NAME} (status=${STATUS}) before redeploy..."
    aws cloudformation delete-stack --stack-name "${STACK_NAME}" --region "${REGION}"
    aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}" --region "${REGION}"
    echo "Stack ${STACK_NAME} deleted."
    ;;
  DELETE_IN_PROGRESS)
    echo "Stack ${STACK_NAME} already deleting — waiting..."
    aws cloudformation wait stack-delete-complete --stack-name "${STACK_NAME}" --region "${REGION}"
    ;;
  *)
    echo "Stack ${STACK_NAME} status=${STATUS} — no delete needed."
    ;;
esac

# Role com nome fixo de deploy antigo (template sem RoleName já não cria isto).
LEGACY_ROLE="origemlab-ollama-ec2-${STACK_NAME}"
if aws iam get-role --role-name "${LEGACY_ROLE}" >/dev/null 2>&1; then
  echo "Removing orphaned IAM role ${LEGACY_ROLE}..."
  PROFILES="$(aws iam list-instance-profiles-for-role --role-name "${LEGACY_ROLE}" \
    --query 'InstanceProfiles[*].InstanceProfileName' --output text 2>/dev/null || true)"
  for p in ${PROFILES}; do
    [ -z "${p}" ] && continue
    aws iam remove-role-from-instance-profile --instance-profile-name "${p}" --role-name "${LEGACY_ROLE}" || true
    aws iam delete-instance-profile --instance-profile-name "${p}" || true
  done
  aws iam detach-role-policy --role-name "${LEGACY_ROLE}" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
  aws iam delete-role --role-name "${LEGACY_ROLE}" || true
fi
