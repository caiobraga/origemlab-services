# Scraper precisa de Chromium (Puppeteer); fases edital usam TypeScript (tsx).
# Paths no container espelham o monorepo (scraper-runner, ingestion-pipeline-service, …)
# para que imports ../../scraper-runner/... funcionem a partir de /app/pipeline/src.
FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app
RUN chown -R pptruser:pptruser /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

COPY services/scraper-runner/package.json services/scraper-runner/package-lock.json ./scraper-runner/
RUN cd scraper-runner && npm ci --omit=dev

COPY services/document-processor/package.json services/document-processor/package-lock.json ./document-processor/
RUN cd document-processor && npm ci --omit=dev

COPY services/process-edital-service/package.json services/process-edital-service/package-lock.json ./process-edital-service/
RUN cd process-edital-service && npm ci --omit=dev

COPY services/validate-edital-service/package.json services/validate-edital-service/package-lock.json ./validate-edital-service/
RUN cd validate-edital-service && npm ci --omit=dev

COPY services/ingestion-pipeline-service/package.json services/ingestion-pipeline-service/package-lock.json ./ingestion-pipeline-service/
RUN cd ingestion-pipeline-service && npm ci --omit=dev

COPY services/edital-pipeline-service/package.json services/edital-pipeline-service/package-lock.json ./edital-pipeline-service/
RUN cd edital-pipeline-service && npm ci --omit=dev

COPY services/unified-pipeline-service/package.json services/unified-pipeline-service/package-lock.json ./pipeline/
RUN cd pipeline && npm ci --omit=dev

COPY services/scraper-runner/src ./scraper-runner/src
COPY services/document-processor/src ./document-processor/src
COPY services/process-edital-service/src ./process-edital-service/src
COPY services/validate-edital-service/src ./validate-edital-service/src
COPY services/ingestion-pipeline-service/src ./ingestion-pipeline-service/src
COPY services/edital-pipeline-service/src ./edital-pipeline-service/src
COPY services/unified-pipeline-service/src ./pipeline/src
COPY shared /shared

WORKDIR /app/pipeline
RUN chown -R pptruser:pptruser /app

USER pptruser

CMD ["npm", "run", "start"]
