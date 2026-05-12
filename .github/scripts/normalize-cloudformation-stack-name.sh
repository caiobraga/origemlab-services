#!/usr/bin/env bash
set -euo pipefail

name="${1:?stack name required}"
name="${name//_/-}"

if [[ ! "${name}" =~ ^[a-zA-Z][-a-zA-Z0-9]*$ ]]; then
  echo "CloudFormation stack name must match [a-zA-Z][-a-zA-Z0-9]* (letters, digits, hyphens only)." >&2
  echo "Use names like origemlab-document-processor, not origemlab_document_processor." >&2
  echo "Invalid value: ${1}" >&2
  exit 1
fi

printf '%s' "${name}"
