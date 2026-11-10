# Agentic Task Manager

Ver `GLOSSARY.md`, `docs/adr/` e `.scratch/nucleo/spec.md`.

## Estrutura

- `daemon/` — daemon TypeScript/Node + SQLite + API HTTP (ADR-0005, ADR-0007). Módulos: `src/api` (HTTP), `src/db` (SQLite), `src/domain` (regras).
- `ui/` — SPA (React, TypeScript, Vite, Tailwind, shadcn/ui; ADR-0010), projeto independente; fala só com a API. Dev: `cd ui && npm ci && npm run dev` (proxy `/api` → daemon, sem CORS); testes: `npm test`; E2E do fluxo de Aprovação: `npm run e2e` (sobe daemon real com banco temporário e tokens descartáveis + build da UI em portas 4391/4392, semeia pela API; requer o Chromium do Playwright, ou `E2E_CHROMIUM_PATH=<chromium>` para usar um já instalado; fonte em `ui/e2e/`); produção: Docker serve o build em :5173. Ainda não estão na nova UI: editar a Área prevista e as ações da fase Execução (converter, iniciar, aguardar, retomar, validar, concluir); use a API para isso.

## Rodar

Requer Node >= 24 (usa `node:sqlite` e execução de TypeScript nativa).

```sh
cd daemon && npm install
npm start          # API em http://127.0.0.1:3000 (ATM_PORT, ATM_DB_PATH=./data/atm.db)
cd ui && npm ci && npm run dev    # UI em dev (Vite, proxy /api → daemon); `npm run build && npm start` serve o build em http://127.0.0.1:5173 (ATM_API_URL aponta a API)
```

## Docker Compose

```sh
cp .env.example .env     # defina ATM_HUMAN_TOKEN (obrigatório); portas opcionais
docker compose up -d --build --wait   # API em http://127.0.0.1:3000, UI em http://127.0.0.1:5173
docker compose down                   # para (os dados ficam)
```

Dados em volumes nomeados: `atm-db` (SQLite, `/data/db`), `atm-attachments` (anexos, `ATM_ATTACHMENTS_DIR=/data/attachments`) e `atm-logs` (**reservado** para os logs das Rodadas da fase 2; o daemon hoje só escreve no stdout e não grava nada ali). Sobrevivem a `down`/`up`; `docker compose down -v` os apaga. Portas só em `127.0.0.1`. `ATM_HUMAN_TOKEN` é obrigatório (o compose recusa subir sem ele); `ATM_AGENT_TOKENS` (`id:token,...`) é opcional. Todas as rotas exigem `Authorization: Bearer <token>`, exceto `GET /health` (healthcheck, sem token). Na UI, informe o token no formulário "Salvar token": ele fica no `localStorage` do navegador e é enviado como `Authorization: Bearer` em cada requisição (nunca é embutido no código). Healthcheck da API em `GET /health`; a UI só sobe com a API saudável. Configuração por variáveis (`.env`, ver `.env.example`); nunca commite segredos.

## Atualização da produção (por tag)

Decisão em `docs/adr/0011-*.md`. Três ambientes separados:

- **Desenvolvimento (sem Docker):** em outro checkout, como em "Rodar" acima, com banco descartável e portas que não colidem com a produção, por exemplo `ATM_PORT=3010 ATM_DB_PATH=/tmp/atm-dev.db npm start` em `daemon/`. Testes (`npm test`) já usam SQLite temporário. Nunca use o `.env` nem o volume da produção.
- **Produção:** um clone separado (sugestão `~/atm-prod`) do repositório do GitHub, com o próprio `.env` (tokens só ali; `.env` não é versionado). Mantém `name: agentic-task-manager` no Compose, então reaproveita os volumes `atm-*` existentes. Rodadas que alteram o ATM trabalham em Workspaces do volume `atm-workspaces`, nunca neste clone.
- **GitHub:** agentes só empurram branches. Quem faz merge no `main` e cria a tag é o humano; a produção só muda quando uma tag nova é atualizada.

Fluxo: dev → branch → PR/merge no `main` → tag → atualizar.

```sh
# no checkout de desenvolvimento, depois do merge
git tag v1.2.0 && git push origin v1.2.0
# no clone de produção
cd ~/atm-prod
scripts/atualizar.sh            # leva à maior tag vX.Y.Z do origin
scripts/atualizar.sh v1.1.0     # ou a uma tag escolhida (serve para voltar de versão)
```

O script: `fetch --tags`; resolve a tag; se a produção já está nela, informa e sai com 0; para o `daemon`; copia o `atm.db` (e `-wal`/`-shm`, se existirem) para o diretório de backups; faz checkout da tag; roda `docker compose up -d --build --wait` com `ATM_VERSAO=<tag>` (repassada ao daemon pelo Compose). Só depois do sucesso poda os backups e grava o estado. Recusa rodar sem remote `origin`, com alterações não commitadas, ou com tag inexistente (nada é alterado). Opera sempre no clone onde está o script.

Variáveis (todas opcionais):

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ATM_BACKUP_DIR` | `~/atm-backups` | onde ficam os backups `atm-<data>-<hora>-<tag anterior>.db` |
| `ATM_BACKUPS_MANTER` | `5` | quantos backups manter (poda só após atualização bem-sucedida) |
| `ATM_ESTADO_DIR` | `~/atm-prod/run` | onde gravar `ultima-atualizacao.json` |
| `ATM_DB_DIR` | (vazio) | diretório com o `atm.db`, em vez de ler/escrever o volume `atm-db` via `docker compose cp`; usado nos testes |

**Rollback automático:** se o `up --wait` falhar (algum healthcheck não fica saudável), o script para o daemon, restaura o backup, volta o checkout à tag anterior e sobe de novo. Códigos de saída: `0` sucesso ou no-op; `1` erro, incluindo "rollback realizado"; `3` o rollback também falhou (o backup é preservado e a mensagem diz onde; intervenção manual). `ultima-atualizacao.json` registra `resultado` (`sucesso`, `rollback` ou `erro_rollback`), `tag_de`, `tag_para`, `motivo`, `em` (UTC), `versao_rodando` e `backup`.

**Rodadas em andamento** são interrompidas pela parada do daemon. No boot ficam `interrompida` (não contam como falha) e uma nova Rodada retoma a partir do último Checkpoint (ADR-0004). Não há modo de drenagem: prefira atualizar sem Rodadas ativas.

**O que o rollback não recupera:** dados criados depois da atualização (o banco volta ao instante do backup) e mudanças em volumes além do `atm.db`. Migrações só andam para frente; o backup é o único caminho de volta. Anexos, logs, repositórios e Workspaces não são copiados pelo script.

Teste do script (sem Docker real, rede nem alteração do repositório): `bash scripts/atualizar.test.sh`.

*Etapa 2 (planejada, não implementada):* botão "Atualizar" na UI, só para o humano, que grava um pedido consumido por uma unit `systemd --user` e roda este mesmo script. Hoje a atualização é só pelo terminal.

## Contextos (RF10)

API: `POST/GET /contextos`, `GET /contextos/arvore`, `GET|PATCH /contextos/:id`, `GET /contextos/:id/resolvido` (herança resolvida), `GET /contextos/:id/tarefas[?subarvore=1]`, `PUT /tarefas/:id/contexto`; `POST /tarefas` aceita `contextId`. **Só o humano** cria/edita Contextos (`POST /contextos`, `PATCH /contextos/:id`) e reatribui Tarefa a Contexto (`PUT /tarefas/:id/contexto`): agente recebe 403 (os `GET` ficam abertos a agentes). Config estruturada (`repository`, `testCommands`, `concurrencyLimit`): filho sobrescreve, `null` herda. `instructions`: somam do geral ao específico (último vence).

## Anexos (RF13)

`POST /tarefas/:id/anexos?nome=x.pdf` e `POST /contextos/:id/anexos?nome=x.pdf` (corpo = bytes do arquivo, `Content-Type` vira o tipo; limite 25 MiB, 413 acima), `GET /{tarefas,contextos}/:id/anexos`, `GET /anexos/:id` (download), `GET /anexos/:id/texto` (texto extraído; 404 se não houver). Arquivos ficam em `ATM_ATTACHMENTS_DIR` (padrão `./data/attachments`) sob id gerado; o nome enviado é sanitizado. Texto é extraído de `.txt`, `.md`, `.docx` e `.pdf` e indexado em FTS5 (`anexos_fts`; `abrirAnexos().buscar()` para a busca textual). Imagens e planilhas só ficam como arquivo. Limitação: PDF é melhor esforço (operadores Tj/TJ em streams Flate/sem filtro); fontes com codificação própria (CID/Identity-H), PDFs escaneados ou criptografados rendem texto vazio/parcial; `.docx` lê só o corpo (`word/document.xml`).

## Testes

```sh
cd daemon && npm test && npm run typecheck
cd ui && npm test && npm run typecheck && npm run build
cd ui && npm run e2e   # E2E com Playwright; E2E_CHROMIUM_PATH=<chromium> usa um Chromium já instalado
```

Os testes sobem o daemon real com um SQLite temporário e exercitam só a API HTTP.

## Comentários e histórico

- `POST /tarefas/:id/comentarios` `{texto, tipo?: comentario|pergunta|resposta, respondeA?}`: o autor vem do token. `resposta` exige `respondeA` apontando para uma `pergunta` da mesma Tarefa.
- `GET /tarefas/:id/eventos`: histórico cronológico com comentários, transições e Aprovações (autor e horário em cada item).
- Histórico imutável: PUT/PATCH/DELETE nessas rotas devolvem 405.
- UI: botão "histórico" em cada Tarefa mostra a linha do tempo e o formulário de comentário.

## Dependências brandas (RF5)

`POST /tarefas/:id/dependencias {dependeDe}` (B depende de A; 400 para auto-dependência, ciclo ou duplicata), `DELETE /tarefas/:id/dependencias/:aId`. Cada Tarefa traz `dependeDe` e `dependenciasPendentes` (aviso: A ainda não está Aprovada). Com pendência, `iniciar`, `iniciar-execucao` e `converter-execucao` devolvem 409; `POST /tarefas/:id/forcar-inicio` (só humano, 403 para agente; vale para Autorizada → Explorando e Na fila → Em execução) inicia mesmo assim e grava autor, horário e motivo em `tarefa_eventos`. A dependência está satisfeita quando A está Aprovada ou já seguiu para a Execução (Na fila, Em execução, Em validação, Concluído). Rejeitar ou reabrir A move cada dependente ativo (Autorizada, Explorando, Plano pronto, Na fila, Em execução, Em validação) para "Aguardando humano" com o motivo no evento (`dependencia-rejeitada` / `dependencia-reaberta`). **Declarar** dependência é permitido ao agente (faz parte do planejamento); **remover** (`DELETE`) é só do humano.

## Prioridade (RF8)

`PUT /tarefas/:id/prioridade` com `{nivel: baixa|média|alta|urgente, impacto, urgencia, esforco}`. O agente sugere (justificativa obrigatória); o humano altera sem exigir justificativa. Sugestão de agente nunca sobrescreve valor definido pelo humano (409). Cada Tarefa traz `priority` (nível, justificativa, origem, autor); sem definição vale `média`. `GET /tarefas` (e a lista da UI) ordena por prioridade e depois por chegada. Terminologia: ver Prioridade em `GLOSSARY.md`.

## Área prevista e sobreposição (RF18)

`PUT /tarefas/:id/area-prevista` com `{"paths": ["src/api", "ui/*.js"]}` registra a Área prevista do plano (caminhos, diretórios ou globs `*`, `?`, `**`; vira evento no histórico; recusado após Aprovado/Rejeitado). `GET /tarefas` e as respostas das ações devolvem `intendedArea` e `overlapWarnings` (outras Tarefas abertas, isto é, não Rejeitadas, do mesmo repositório resolvido pelo Contexto, com Área sobreposta); `GET /tarefas/:id/sobreposicao` devolve só os avisos. O aviso nunca bloqueia: aprovar continua possível. A UI mostra o aviso na lista, antes dos botões de Aprovação.

## Contexto consolidado versionado (RF12)

API: `GET /contextos/:id/consolidado` (versão atual; `version: 0` se vazio), `GET .../consolidado/versoes` (histórico completo), `PUT .../consolidado` com `{text, taskId?}` (cria nova versão numerada; `taskId` = Tarefa de origem; humano ou agente atualizam direto, autor gravado), `POST .../consolidado/reverter` com `{version?}` (padrão: a anterior à atual). Reverter cria uma NOVA versão com `revertedFrom`; nada é apagado. O texto de cada versão é indexado em `consolidado_fts` (FTS5, `buscar()` em `daemon/src/db/consolidado.ts`) para a busca textual.

## Fase Execução e mudança material (RF2, RF4, RF6, RF17)

Dados da Execução ficam na tabela lateral `tarefa_execucao` (objetivo, repositório principal, critérios, entregáveis, permissões, `puladaExploracao`). Só o humano cria/move na Execução (agente recebe 403).

- `POST /tarefas` com `"phase": "Execução"` + `objetivo`, `repositorioPrincipal`, `criterios[]` (humano; evento `criar-execucao` registra que a Exploração foi pulada).
- `POST /tarefas/:id/converter-execucao` (mesmo corpo): mantém o histórico e grava o evento `converter-execucao` (motivo indica se a Exploração foi pulada). Não vale para Rejeitado.
- Estados: `iniciar-execucao` (Na fila→Em execução), `aguardar-humano-execucao`, `retomar-execucao`, `validar-execucao` (→Em validação), `concluir-execucao` (→Concluído).
- `GET|PATCH /tarefas/:id/execucao`: editar repositório principal, critérios, entregáveis ou permissões (valor diferente) de plano Aprovado ou de Tarefa em Execução devolve-a a Exploração · "Plano pronto para aprovação" (evento `mudanca-material`); exige nova Aprovação.

## Subtarefas (RF2, RF3)

Relação mãe→filha na tabela lateral `subtarefas` (`daemon/src/db/subtarefas.ts`; lógica em `src/api/subtarefas.ts` e `src/domain/subtarefas.ts`).

- `POST /tarefas` com `parentId`: cria Subtarefa sempre em Exploração · Novo (agente ou humano). Agente com `phase: "Execução"` recebe 403; mãe inexistente, 404. Cria o evento `subtarefa-criada` na mãe.
- `PATCH /tarefas/:id` `{title?, description?}`: só humano, só Subtarefa (evento `editar`).
- `POST /tarefas/:id/aprovar-subtarefa` (humano; Subtarefa em Novo → Aprovado) ou `rejeitar`/`reabrir`. A aprovada segue sozinha (ex.: `converter-execucao`), sem esperar a mãe.
- Ajuste por comentário: `POST /tarefas/:id/comentarios` na Subtarefa ou na mãe (RF3, RF9).
- `GET /tarefas/:id` (e `GET /tarefas`) devolvem `maeId`, `subtarefas[{id,title,state,decisao}]` e `resolucaoSubtarefas {total,aprovadas,rejeitadas,resolvida}`. Quando a última Subtarefa é aprovada/rejeitada grava o evento `mae-resolvida` na mãe; reabrir desfaz a resolução.

## Busca textual (RF11)

`GET /busca?q=<texto>[&contexto=<id>[&subarvore=1]]` (autenticação como nas demais rotas; `q` vazio ou sem letras/números → 400; `contexto` inexistente → 400). Devolve uma lista unificada de `{tipo, id, snippet, taskId, contextId[, version]}` com `tipo` ∈ `tarefa` (título+descrição), `comentario`, `consolidado` (qualquer versão; `id` = Contexto, `version` = versão que casou) e `anexo` (texto extraído; `taskId` null se o anexo é de um Contexto). O `snippet` marca os termos entre `[colchetes]`. Busca insensível a acentos e caixa (FTS5 `unicode61 remove_diacritics 2`); todas as palavras devem casar (AND) e operadores FTS na consulta (`"`, `*`, `OR`, `NEAR`, `:`) são tratados como texto literal. Com `contexto`, só resultados daquele Contexto; com `subarvore=1`, também dos descendentes. Resultados sem Contexto só aparecem sem filtro. Limite de 100 por tipo.

Índices: `tarefas_fts` e `comentarios_fts` (`daemon/src/db/busca.ts`) são mantidos por triggers SQLite nas tabelas `tarefas` e `tarefa_comentarios`; ao subir, o daemon indexa linhas pré-existentes (backfill), então bancos antigos funcionam sem migração manual. Consolidado e anexos reutilizam `consolidado_fts` e `anexos_fts`. A UI tem uma caixa de busca que respeita o filtro de Contexto da lista.


## MCP para agentes (RF25)

Pasta `mcp/`: cliente HTTP fino e independente da API do daemon (`ATM_API_URL`), sem regras de negócio: repassa chamadas e devolve os erros da API como `isError`. Usa **só o token do agente** (`ATM_AGENT_TOKEN`, um dos de `ATM_AGENT_TOKENS`; nunca logado). Por isso o agente não aprova, autoriza nem muda estado: a API devolve 403 e as Tarefas criadas ficam em Exploração · Novo.

Ferramentas: `ler_contexto` (`/contextos/:id/resolvido` + `/consolidado`), `buscar` (`/busca`), `comentar` (`/tarefas/:id/comentarios`), `criar_tarefa` e `criar_subtarefa` (`POST /tarefas`, esta com `parentId`), `ler_tarefa` (`/tarefas/:id` + `/eventos`), e, para Rodadas, `checkpoint` (`POST /tarefas/:id/checkpoint`), `perguntar` (`/perguntar`, leva a "Aguardando humano") e `entregar` (`/entregar`, leva a "Plano pronto para aprovação" ou "Em validação"). Não há ferramenta de aprovação, transição ou execução. O processo do agente de cada Rodada recebe `ATM_API_URL`, `ATM_MCP_URL` (`http://mcp:3100/mcp`) e `ATM_AGENT_TOKEN` do agente `orquestrador`, que é obrigatório em `ATM_AGENT_TOKENS` e deve ser o mesmo token do serviço `mcp` (ADR-0008). Rodadas: `GET|POST /tarefas/:id/rodadas` (POST só humano) e `GET /rodadas/:id`.

### MCP do assistente pessoal

Perfil separado do MCP de agentes (`mcp/src/assistente.ts`), para um assistente (ex.: Hermes) operar o sistema inteiro em nome do humano: Contextos (criar/editar/consolidado), Tarefas (criar em lote, editar, mover de Contexto, prioridade, dependências, área prevista, anexos, comentários, transições, Rodadas) e Coletores. Serviço `mcp-assistente` no Compose: `http://127.0.0.1:3101/mcp` (`ATM_ASSISTANT_MCP_PORT`), fala com a API usando `ATM_HUMAN_TOKEN` (o autor no histórico é `humano`). O cliente MCP autentica com `ATM_ASSISTANT_MCP_TOKEN` (≥16 caracteres; se vazio, usa o próprio `ATM_HUMAN_TOKEN`), então o token humano pode ficar fora da config do assistente.

Os portões de aprovação (`aprovar`, `aprovar-subtarefa`, `forcar-inicio`, `converter-execucao`, `concluir-execucao`) **não** são expostos por padrão, para manter "agente nunca aprova a própria execução" (ADR-0001) mesmo que o assistente seja manipulado. `ATM_MCP_PERMITIR_APROVACAO=1` os liga (inclui a ferramenta `converter_em_execucao`). Atenção: com o serviço no ar, a credencial humana vive nesse container; mantenha a porta só em 127.0.0.1. Stdio: `ATM_MCP_PERFIL=assistente ATM_HUMAN_TOKEN=... node mcp/src/main.ts --stdio`.

- **HTTP (padrão):** Streamable HTTP em `http://127.0.0.1:3100/mcp` (`ATM_MCP_PORT`), publicado só em 127.0.0.1; dentro do Docker escuta em 0.0.0.0. Toda requisição precisa de `Authorization: Bearer <ATM_AGENT_TOKEN>`, senão 401. `GET /health` sem autenticação. O serviço `mcp` do `docker compose up` sobe depois do daemon saudável; sem `ATM_AGENT_TOKEN` no `.env` o compose recusa com mensagem clara.
- **stdio:** `docker compose run --rm -i -e ATM_MCP_TRANSPORT=stdio mcp`, ou localmente `ATM_API_URL=... ATM_AGENT_TOKEN=... node mcp/src/main.ts --stdio`.
- Local sem Docker: `cd mcp && npm ci && npm start` (host `ATM_MCP_HOST`, padrão 127.0.0.1). Testes: `npm test` (sobe o daemon real) e `npm run typecheck`.

## Executor Hermes (ADR-0009)

`ATM_EXECUTOR=hermes` liga o adaptador sobre `hermes chat --query-file … --format stream-json --in <workspace>` (opcionais: `ATM_HERMES_MODEL`, `ATM_HERMES_MAX_TURNS`, `ATM_HERMES_RUN_BUDGET`, `ATM_HERMES_BIN`); sem a variável, nenhum Executor está configurado e as Rodadas falham com essa mensagem. Valor desconhecido faz o daemon recusar iniciar. O agente recebe só `PATH`/`HOME`, o ambiente da Rodada e as chaves do provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`…); nunca `ATM_HUMAN_TOKEN`/`ATM_GITHUB_TOKEN`. O uso de tokens vem do registro `result` do stream-json (não do `--usage-file`, que só vale em `--oneshot`); sem ele, "uso desconhecido". A imagem do daemon instala o Hermes pelo instalador oficial. A suíte automática nunca chama o modelo: o contrato do Executor roda no falso e, com `ATM_TESTE_HERMES=1`, no Hermes real; `ATM_TESTE_HERMES=1 scripts/verificar-hermes.sh` roda uma Tarefa de exemplo de ponta a ponta (custa tokens).

## Segurança e limites

- **Tokens:** o daemon recusa iniciar sem `ATM_HUMAN_TOKEN`, e recusa tokens (humano ou de agente) que comecem com `troque-por` (valor de exemplo do `.env.example`) ou tenham menos de 16 caracteres. `startDaemon` exige `credenciais` (não existe modo "sem autenticação"). `ATM_AGENT_TOKEN` (usado pelo serviço `mcp`) **deve ser igual** ao token de um agente em `ATM_AGENT_TOKENS`; o compose não o deriva sozinho.
- **`.env` como fallback:** se `ATM_HUMAN_TOKEN` não vier do ambiente, o daemon lê `./.env`. Isso é só para desenvolvimento local sem Docker (ADR-0007); no Compose use variáveis de ambiente.
- **CORS:** só as origens em `ATM_CORS_ORIGIN` (vírgula; padrão `http://127.0.0.1:5173,http://localhost:5173`) recebem `Access-Control-Allow-Origin`; nunca `*`.
- **Limites:** corpo JSON até 1 MiB e upload até 25 MiB; acima disso, 413 imediato. Downloads de anexos saem com `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` e `application/octet-stream` exceto png/jpeg/gif/webp/pdf/txt.
- **Auditoria:** `/health` e `OPTIONS` não são auditados; requisições sem token válido são registradas como `anonimo` (401).
- **FTS5** do SQLite é obrigatório (a abertura falha com erro claro sem ele).
