FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node
ENV ATM_MCP_HOST=0.0.0.0 ATM_MCP_PORT=3100
EXPOSE 3100
CMD ["node", "src/main.ts"]
