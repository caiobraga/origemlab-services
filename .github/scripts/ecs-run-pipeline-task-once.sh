#!/usr/bin/env bash
# Dispara uma task Fargate no cluster (útil quando OrchestrationMode=scheduled e não há ECS Service).
set -euo pipefail

STACK_NAME="${1:?stack name required}"
SUBNET_IDS="${2:?comma-separated subnet ids}"
SECURITY_GROUP_IDS="${3:?comma-separated security group ids}"
REGION="${AWS_REGION:-us-east-1}"

cf_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text 2>/dev/null || true
}

CLUSTER="$(cf_output EcsClusterName)"
TASK_DEF="$(cf_output TaskDefinitionArn)"

if [ -z "${CLUSTER}" ] || [ "${CLUSTER}" = "None" ]; then
  echo "WARN: EcsClusterName missing in stack ${STACK_NAME} — skip run-task."
  exit 0
fi
if [ -z "${TASK_DEF}" ] || [ "${TASK_DEF}" = "None" ]; then
  echo "WARN: TaskDefinitionArn missing in stack ${STACK_NAME} — skip run-task."
  exit 0
fi

NET_CFG="awsvpcConfiguration={subnets=[${SUBNET_IDS}],securityGroups=[${SECURITY_GROUP_IDS}],assignPublicIp=ENABLED}"

echo "ECS run-task: cluster=${CLUSTER} taskDefinition=${TASK_DEF}"
TASK_ARN="$(aws ecs run-task \
  --cluster "${CLUSTER}" \
  --task-definition "${TASK_DEF}" \
  --launch-type FARGATE \
  --region "${REGION}" \
  --network-configuration "${NET_CFG}" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [ -z "${TASK_ARN}" ] || [ "${TASK_ARN}" = "None" ]; then
  echo "::error::ecs run-task returned no taskArn (check subnets/SG and task execution role)"
  exit 1
fi

echo "Started task: ${TASK_ARN}"
echo "Console: ECS → cluster ${CLUSTER} → Tasks"
