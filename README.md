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
cp .env.example .env     # defina ATM_HUMAN_TOKEN (obrigatório); portas opcionais
docker compose up -d --build --wait   # API em http://127.0.0.1:3000, UI em http://127.0.0.1:5173
docker compose down                   # para (os dados ficam)
```

Dados em volumes nomeados: `atm-db` (SQLite, `/data/db`), `atm-attachments` e `atm-logs` (reservados). Sobrevivem a `down`/`up`; `docker compose down -v` os apaga. Portas só em `127.0.0.1`. `ATM_HUMAN_TOKEN` é obrigatório (o compose recusa subir sem ele); `ATM_AGENT_TOKENS` (`id:token,...`) é opcional. Todas as rotas exigem `Authorization: Bearer <token>`, exceto `GET /health` (healthcheck, sem token). Na UI, informe o token no formulário "Salvar token": ele fica no `localStorage` do navegador e é enviado como `Authorization: Bearer` em cada requisição (nunca é embutido no código). Healthcheck da API em `GET /health`; a UI só sobe com a API saudável. Configuração por variáveis (`.env`, ver `.env.example`); nunca commite segredos.

## Contextos (RF10)

API: `POST/GET /contextos`, `GET /contextos/arvore`, `GET|PATCH /contextos/:id`, `GET /contextos/:id/resolvido` (herança resolvida), `GET /contextos/:id/tarefas[?subarvore=1]`, `PUT /tarefas/:id/contexto`; `POST /tarefas` aceita `contextId`. Config estruturada (`repository`, `testCommands`, `concurrencyLimit`): filho sobrescreve, `null` herda. `instructions`: somam do geral ao específico (último vence).

## Testes

```sh
cd daemon && npm test && npm run typecheck
```

Os testes sobem o daemon real com um SQLite temporário e exercitam só a API HTTP.

## Comentários e histórico

- `POST /tarefas/:id/comentarios` `{texto, tipo?: comentario|pergunta|resposta, respondeA?}`: o autor vem do token. `resposta` exige `respondeA` apontando para uma `pergunta` da mesma Tarefa.
- `GET /tarefas/:id/eventos`: histórico cronológico com comentários, transições e Aprovações (autor e horário em cada item).
- Histórico imutável: PUT/PATCH/DELETE nessas rotas devolvem 405.
- UI: botão "histórico" em cada Tarefa mostra a linha do tempo e o formulário de comentário.
