FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# git: Workspaces das Rodadas (ADR-0002, ADR-0006).
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Dados persistentes (banco, anexos, logs) ficam em /data, montado como volume.
RUN mkdir -p /data/db /data/attachments /data/logs /data/workspaces /data/repos && chown -R node:node /data
USER node
ENV ATM_HOST=0.0.0.0 ATM_PORT=3000 ATM_DB_PATH=/data/db/atm.db ATM_ATTACHMENTS_DIR=/data/attachments
EXPOSE 3000
CMD ["node", "src/main.ts"]
