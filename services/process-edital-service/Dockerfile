FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install

COPY src ./src

CMD ["npm","run","start"]

