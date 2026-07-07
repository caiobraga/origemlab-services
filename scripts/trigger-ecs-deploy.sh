#!/usr/bin/env bash
# Dispara o deploy ECS (Ollama + unified-pipeline) no GitHub Actions.
# Uso:
#   ./scripts/trigger-ecs-deploy.sh
#   ./scripts/trigger-ecs-deploy.sh continuous
#   ./scripts/trigger-ecs-deploy.sh scheduled
set -euo pipefail

ORCH="${1:-continuous}"
if [ "${ORCH}" != "continuous" ] && [ "${ORCH}" != "scheduled" ]; then
  echo "Modo inválido: ${ORCH} (use continuous ou scheduled)"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Instale o GitHub CLI (gh) e autentique: gh auth login"
  exit 1
fi

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
if [ -z "${REPO}" ]; then
  echo "Não foi possível detectar o repositório. Rode dentro do clone ou defina GH_REPO."
  exit 1
fi

echo "Disparando deploy-all-ecs-services em ${REPO} (orchestration_mode=${ORCH})..."
gh workflow run deploy-all-ecs-services.yml \
  -f "orchestration_mode=${ORCH}" \
  --ref "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

echo ""
echo "Acompanhe:"
echo "  gh run list --workflow=deploy-all-ecs-services.yml --limit 3"
echo "  gh run watch"
echo ""
echo "Após deploy (modo continuous), no console ECS:"
echo "  cluster origemlab-unified-pipeline → service origemlab-unified-pipeline-worker → 1 task em execução"
