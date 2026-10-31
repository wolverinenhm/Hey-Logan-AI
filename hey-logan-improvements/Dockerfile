FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund

COPY . .

RUN node scripts/setup.js

ENV HEY_AI_DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 8787 8443

VOLUME ["/data"]

CMD ["node", "server/index.js"]
