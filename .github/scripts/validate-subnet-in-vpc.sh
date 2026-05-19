#!/usr/bin/env bash
set -euo pipefail

SUBNET_ID="${1:?subnet id}"
VPC_ID="${2:?vpc id}"
REGION="${AWS_REGION:-us-east-1}"

INFO="$(aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}" \
  --query 'Subnets[0].{VpcId:VpcId,Az:AvailabilityZone,Public:MapPublicIpOnLaunch}' --output json)"

SUBNET_VPC="$(echo "${INFO}" | jq -r '.VpcId')"
PUBLIC="$(echo "${INFO}" | jq -r '.Public')"
AZ="$(echo "${INFO}" | jq -r '.Az')"

if [ "${SUBNET_VPC}" != "${VPC_ID}" ]; then
  echo "::error::Subnet ${SUBNET_ID} is in VPC ${SUBNET_VPC}, but VPC_ID=${VPC_ID}. Use a subnet from the same VPC as ECS."
  exit 1
fi

echo "Subnet ${SUBNET_ID} ok: vpc=${SUBNET_VPC} az=${AZ} MapPublicIpOnLaunch=${PUBLIC}"
if [ "${PUBLIC}" != "true" ]; then
  echo "::warning::Subnet is not 'public' (MapPublicIpOnLaunch=false). Ollama userdata needs Internet (NAT or use a public subnet for OLLAMA_SERVER_SUBNET_ID)."
fi
