FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping curl openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    DB_PATH=/app/data/app.db

COPY --from=build /app /app

EXPOSE 3001
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
