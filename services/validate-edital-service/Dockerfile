# Build from repo root:
#   docker build -f services/validate-edital-service/Dockerfile -t origemlab-validate-edital-service .
FROM node:20-slim

WORKDIR /app

COPY services/validate-edital-service/package.json services/validate-edital-service/package-lock.json ./
RUN npm ci --omit=dev

COPY services/validate-edital-service/src ./src
# Imports em src/lib usam ../../../../shared → /shared no container
COPY shared /shared

ENV NODE_ENV=production

CMD ["npm", "run", "start"]
