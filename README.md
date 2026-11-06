# Agentic Task Manager

Ver `GLOSSARY.md`, `docs/adr/` e `.scratch/nucleo/spec.md`.

## Estrutura

- `daemon/` — daemon TypeScript/Node + SQLite + API HTTP (ADR-0005, ADR-0007). Módulos: `src/api` (HTTP), `src/db` (SQLite), `src/domain` (regras).
- `ui/` — SPA mínima, projeto independente; fala só com a API.

## Rodar

Requer Node >= 24 (usa `node:sqlite` e execução de TypeScript nativa).

```sh
cd daemon && npm install
npm start          # API em http://127.0.0.1:3000 (ATM_PORT, ATM_DB_PATH=./data/atm.db)
cd ui && npm start # UI em http://127.0.0.1:5173 (?api=<url> para outra API)
```

## Docker Compose

```sh
cp .env.example .env     # opcional: muda as portas
docker compose up -d --build --wait   # API em http://127.0.0.1:3000, UI em http://127.0.0.1:5173
docker compose down                   # para (os dados ficam)
```

Dados em volumes nomeados: `atm-db` (SQLite, `/data/db`), `atm-attachments` e `atm-logs` (reservados). Sobrevivem a `down`/`up`; `docker compose down -v` os apaga. Portas só em `127.0.0.1`. Healthcheck da API em `GET /health`; a UI só sobe com a API saudável. Configuração por variáveis (`.env`, ver `.env.example`); nunca commite segredos.

## Contextos (RF10)

API: `POST/GET /contextos`, `GET /contextos/arvore`, `GET|PATCH /contextos/:id`, `GET /contextos/:id/resolvido` (herança resolvida), `GET /contextos/:id/tarefas[?subarvore=1]`, `PUT /tarefas/:id/contexto`; `POST /tarefas` aceita `contextId`. Config estruturada (`repository`, `testCommands`, `concurrencyLimit`): filho sobrescreve, `null` herda. `instructions`: somam do geral ao específico (último vence).

## Testes

```sh
cd daemon && npm test && npm run typecheck
```

Os testes sobem o daemon real com um SQLite temporário e exercitam só a API HTTP.
