FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# git: Workspaces das Rodadas (ADR-0002, ADR-0006). curl/ca-certificates/xz-utils/build-essential: instalador do Hermes.
# Base Debian (glibc), não Alpine: o Hermes instala Python e pacotes nativos via uv, sem suporte confiável em musl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates xz-utils build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Dados persistentes (banco, anexos, logs) ficam em /data, montado como volume.
RUN mkdir -p /data/db /data/attachments /data/logs /data/workspaces /data/repos && chown -R node:node /data
USER node
# Hermes Agent (ADR-0009): instalador oficial, sem setup interativo nem navegador. Instala em
# ~/.hermes/hermes-agent e põe o binário em ~/.local/bin. NÃO testado em build neste repositório; para
# reprodutibilidade, fixe o instalador com --commit <SHA>. Config e chaves do Hermes ficam em ~/.hermes (HOME do node).
ENV PATH=/home/node/.local/bin:$PATH
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup --skip-browser \
 && hermes --version
ENV ATM_HOST=0.0.0.0 ATM_PORT=3000 ATM_DB_PATH=/data/db/atm.db ATM_ATTACHMENTS_DIR=/data/attachments
EXPOSE 3000
CMD ["node", "src/main.ts"]
