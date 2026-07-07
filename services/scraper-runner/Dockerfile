FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx puppeteer browsers install chrome

COPY src ./src

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

CMD ["node", "src/main.mjs", "--source", "all"]

