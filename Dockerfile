FROM node:20-alpine

RUN apk add --no-cache postgresql-client openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/index.js"]