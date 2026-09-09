# Build from repo root:
#   docker build -f services/process-edital-service/Dockerfile -t origemlab-process-edital-service .
FROM node:20-slim

WORKDIR /app

COPY services/process-edital-service/package.json services/process-edital-service/package-lock.json ./
RUN npm ci --omit=dev

COPY services/process-edital-service/src ./src
# Imports em src/lib usam ../../../../shared → /shared no container
COPY shared /shared

ENV NODE_ENV=production

CMD ["npm", "run", "start"]
