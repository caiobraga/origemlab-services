FROM node:20-slim

WORKDIR /app

COPY services/process-edital-service/package.json services/process-edital-service/package-lock.json ./process-edital-service/
RUN cd process-edital-service && npm ci --omit=dev

COPY services/validate-edital-service/package.json services/validate-edital-service/package-lock.json ./validate-edital-service/
RUN cd validate-edital-service && npm ci --omit=dev

COPY services/edital-pipeline-service/package.json services/edital-pipeline-service/package-lock.json ./pipeline/
RUN cd pipeline && npm ci --omit=dev

COPY services/process-edital-service/src ./process-edital-service/src
COPY services/validate-edital-service/src ./validate-edital-service/src
COPY services/edital-pipeline-service/src ./pipeline/src

WORKDIR /app/pipeline
ENV NODE_ENV=production

CMD ["npm", "run", "start"]
