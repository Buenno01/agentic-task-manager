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

## Testes

```sh
cd daemon && npm test && npm run typecheck
```

Os testes sobem o daemon real com um SQLite temporário e exercitam só a API HTTP.
