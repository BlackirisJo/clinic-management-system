FROM node:20-alpine

# postgresql16-client: مطابقة إصدار العميل مع سيرفر postgres:16 في docker-compose
# (عميل أحدث يصدر SET transaction_timeout غير مدعوم في PG16 ويفشل الاسترجاع)
RUN apk add --no-cache postgresql16-client openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["sh", "-c", "node dist/scripts/migrate.js && npm run seed && node dist/index.js"]