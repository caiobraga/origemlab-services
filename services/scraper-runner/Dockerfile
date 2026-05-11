FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

CMD ["node", "src/main.mjs", "--source", "all"]

