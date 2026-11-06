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

Dados em volumes nomeados: `atm-db` (SQLite, `/data/db`), `atm-attachments` (anexos, `ATM_ATTACHMENTS_DIR=/data/attachments`) e `atm-logs` (reservado). Sobrevivem a `down`/`up`; `docker compose down -v` os apaga. Portas só em `127.0.0.1`. `ATM_HUMAN_TOKEN` é obrigatório (o compose recusa subir sem ele); `ATM_AGENT_TOKENS` (`id:token,...`) é opcional. Todas as rotas exigem `Authorization: Bearer <token>`, exceto `GET /health` (healthcheck, sem token). Na UI, informe o token no formulário "Salvar token": ele fica no `localStorage` do navegador e é enviado como `Authorization: Bearer` em cada requisição (nunca é embutido no código). Healthcheck da API em `GET /health`; a UI só sobe com a API saudável. Configuração por variáveis (`.env`, ver `.env.example`); nunca commite segredos.

## Contextos (RF10)

API: `POST/GET /contextos`, `GET /contextos/arvore`, `GET|PATCH /contextos/:id`, `GET /contextos/:id/resolvido` (herança resolvida), `GET /contextos/:id/tarefas[?subarvore=1]`, `PUT /tarefas/:id/contexto`; `POST /tarefas` aceita `contextId`. Config estruturada (`repository`, `testCommands`, `concurrencyLimit`): filho sobrescreve, `null` herda. `instructions`: somam do geral ao específico (último vence).

## Anexos (RF13)

`POST /tarefas/:id/anexos?nome=x.pdf` e `POST /contextos/:id/anexos?nome=x.pdf` (corpo = bytes do arquivo, `Content-Type` vira o tipo; limite 25 MiB, 413 acima), `GET /{tarefas,contextos}/:id/anexos`, `GET /anexos/:id` (download), `GET /anexos/:id/texto` (texto extraído; 404 se não houver). Arquivos ficam em `ATM_ATTACHMENTS_DIR` (padrão `./data/attachments`) sob id gerado; o nome enviado é sanitizado. Texto é extraído de `.txt`, `.md`, `.docx` e `.pdf` e indexado em FTS5 (`anexos_fts`; `abrirAnexos().buscar()` para o ticket 13). Imagens e planilhas só ficam como arquivo. Limitação: PDF é melhor esforço (operadores Tj/TJ em streams Flate/sem filtro); fontes com codificação própria (CID/Identity-H), PDFs escaneados ou criptografados rendem texto vazio/parcial; `.docx` lê só o corpo (`word/document.xml`).

## Testes

```sh
cd daemon && npm test && npm run typecheck
```

Os testes sobem o daemon real com um SQLite temporário e exercitam só a API HTTP.

## Fase Execução e mudança material (RF2, RF4, RF6, RF17)

Dados da Execução ficam na tabela lateral `tarefa_execucao` (objetivo, repositório principal, critérios, entregáveis, permissões, `puladaExploracao`). Só o humano cria/move na Execução (agente recebe 403).

- `POST /tarefas` com `"phase": "Execução"` + `objetivo`, `repositorioPrincipal`, `criterios[]` (humano; evento `criar-execucao` registra que a Exploração foi pulada).
- `POST /tarefas/:id/converter-execucao` (mesmo corpo): mantém o histórico e grava o evento `converter-execucao` (motivo indica se a Exploração foi pulada). Não vale para Rejeitado.
- Estados: `iniciar-execucao` (Na fila→Em execução), `aguardar-humano-execucao`, `retomar-execucao`, `validar-execucao` (→Em validação), `concluir-execucao` (→Concluído).
- `GET|PATCH /tarefas/:id/execucao`: editar repositório principal, critérios, entregáveis ou permissões (valor diferente) de plano Aprovado ou de Tarefa em Execução devolve-a a Exploração · "Plano pronto para aprovação" (evento `mudanca-material`); exige nova Aprovação.

