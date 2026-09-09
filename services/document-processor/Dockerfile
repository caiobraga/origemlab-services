# Build from repo root:
#   docker build -f services/document-processor/Dockerfile -t origemlab-document-processor .
FROM node:22-bookworm-slim

WORKDIR /app

COPY services/document-processor/package.json services/document-processor/package-lock.json ./
RUN npm ci --omit=dev

COPY services/document-processor/src ./src
# Imports em src usam ../../../shared → /shared no container
COPY shared /shared

ENV NODE_ENV=production
CMD ["node", "src/main.mjs"]
