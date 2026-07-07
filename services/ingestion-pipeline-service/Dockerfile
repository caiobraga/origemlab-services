# Scraper precisa de Chromium (Puppeteer); document-processor roda na mesma task.
FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app
RUN chown -R pptruser:pptruser /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

COPY services/scraper-runner/package.json services/scraper-runner/package-lock.json ./scraper/
RUN cd scraper && npm ci --omit=dev

COPY services/document-processor/package.json services/document-processor/package-lock.json ./document-processor/
RUN cd document-processor && npm ci --omit=dev

COPY services/ingestion-pipeline-service/package.json services/ingestion-pipeline-service/package-lock.json ./pipeline/
RUN cd pipeline && npm ci --omit=dev

COPY services/scraper-runner/src ./scraper/src
COPY services/document-processor/src ./document-processor/src
COPY services/ingestion-pipeline-service/src ./pipeline/src

RUN chown -R pptruser:pptruser /app

USER pptruser
RUN cd /app/scraper && npx puppeteer browsers install chrome

WORKDIR /app/pipeline

CMD ["npm", "run", "start"]
