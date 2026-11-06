FROM node:24-alpine
WORKDIR /app
COPY package.json serve.js index.html app.js ./
USER node
ENV UI_HOST=0.0.0.0 UI_PORT=5173
EXPOSE 5173
CMD ["node", "serve.js"]
