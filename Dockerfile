FROM node:20-alpine

RUN apk add --no-cache postgresql-client openssl

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]