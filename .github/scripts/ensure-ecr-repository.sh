#!/usr/bin/env bash
# Cria o repositório ECR se ainda não existir (bootstrap sem CloudFormation manual).
set -euo pipefail

REPO="${1:?Usage: ensure-ecr-repository.sh <repository-name>}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:?AWS_REGION required}}"

if aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" >/dev/null 2>&1; then
  echo "ECR repository ${REPO} already exists."
else
  echo "Creating ECR repository ${REPO} in ${REGION}..."
  aws ecr create-repository \
    --repository-name "${REPO}" \
    --image-scanning-configuration scanOnPush=true \
    --region "${REGION}"
  echo "Created ${REPO}."
fi
