FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json server.js proxy.js ./
COPY --from=build /app/dist ./dist
USER node
ENV UI_HOST=0.0.0.0 UI_PORT=5173
EXPOSE 5173
CMD ["node", "server.js"]
