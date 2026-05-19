#!/usr/bin/env bash
# Resolve Amazon Linux 2023 AMI without CloudFormation SSM dynamic reference (GithubActions may lack ssm:GetParameters).
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:?AWS_REGION required}}"
PREFERRED="${1:-}"

if [ -n "${PREFERRED}" ]; then
  echo "${PREFERRED}"
  exit 0
fi

if id="$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --region "${REGION}" \
  --query Parameter.Value \
  --output text 2>/dev/null)" && [ -n "${id}" ] && [ "${id}" != "None" ]; then
  echo "${id}"
  exit 0
fi

id="$(aws ec2 describe-images \
  --region "${REGION}" \
  --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-*-kernel-*-x86_64" \
    "Name=state,Values=available" \
    "Name=architecture,Values=x86_64" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' \
  --output text)"

if [ -z "${id}" ] || [ "${id}" = "None" ]; then
  echo "::error::Could not resolve AL2023 AMI in ${REGION} (need ec2:DescribeImages or ssm:GetParameters)" >&2
  exit 1
fi

echo "${id}"
