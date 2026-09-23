FROM node:20-alpine

# postgresql18-client: pg_dump must be >= server version; Render runs PostgreSQL 18.
# pg_dump 18 supports dumping from older servers (PG16 local, PG18 Render).
RUN apk add --no-cache postgresql18-client openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "node dist/scripts/migrate.js && npm run seed && node dist/index.js"]