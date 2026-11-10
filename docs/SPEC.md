# Especificação — Agentic Task Manager

Status: confirmado. Escopo da implementação atual: apenas o Núcleo (fase 1, tickets em `.scratch/nucleo/issues/`), executado AFK do início ao fim. Vocabulário em `GLOSSARY.md`; decisões difíceis de reverter em `docs/adr/`.
Legenda: [REQ] requisito do usuário · [DEC] decisão tomada na descoberta · [HIP] hipótese a validar · [SUG] sugestão minha.

## 1. Visão do produto

Problema: um único humano com vários trabalhos e projetos precisa delegar investigação, planejamento e execução a agentes de IA sem perder controle, contexto nem rastreabilidade.
Objetivos: ambiente persistente e local-first onde agentes exploram com autonomia, mas nada é executado sem Aprovação humana explícita; contexto compacto e reutilizável; monitoramento de e-commerce que gera oportunidades como Tarefas.
Usuário: um humano (Vinícius). Escala: 1 cliente Shopify mais projetos pessoais, dezenas de Contextos, 3 a 4 agentes simultâneos, menos de 50 Tarefas novas por dia. [HIP]

## 2. Requisitos funcionais

Tarefas e filas
- RF1 [REQ] Tarefa única com Fase (Exploração ou Execução) e estado, conforme glossário.
- RF2 [DEC] Agentes criam Tarefas e Subtarefas só na Exploração, em "Novo". Humano pode criar direto na Execução, e a escolha fica registrada.
- RF3 [DEC] Subtarefas podem ser editadas, aprovadas, rejeitadas ou ajustadas por edição ou comentário (na Subtarefa ou na mãe). A mãe se resolve quando todas as Subtarefas forem aprovadas ou rejeitadas.
- RF4 [REQ] Converter a própria Tarefa em Execução ou gerar Subtarefas preserva o histórico. Rejeitadas podem ser reabertas.
- RF5 [DEC] Dependência é bloqueio brando: aviso explícito, orquestrador segura a Tarefa, "Forçar início" registrado. Dependência rejeitada leva a Tarefa dependente a "Aguardando humano".
- RF6 [DEC] Mudança material (repositório principal, critérios de aceitação, entregáveis, permissões) exige nova Aprovação. O agente também pode pedir.
- RF7 [REQ] Aprovações individuais, em lote ou por etapas; cada uma explícita e rastreável. Plano aprovado não é execução aprovada.
- RF8 [DEC] Prioridade ordinal com justificativa; o orquestrador inicia por prioridade e depois por chegada, respeitando o limite de concorrência do Contexto.
- RF9 [REQ] Comentários, perguntas e respostas assíncronos; sem chat no MVP. A fila "Aguardando humano" é a caixa de entrada.

Contextos e memória
- RF10 [REQ] Contextos hierárquicos; Tarefa associada a qualquer nível. Configuração estruturada é sobrescrita pelo filho; instruções em texto se somam, e a mais específica vence.
- RF11 [DEC] Pacote inicial pequeno por Rodada; o resto por busca textual (FTS) via ferramentas. Embeddings só se a busca textual falhar.
- RF12 [DEC] Contexto consolidado atualizado direto pelo agente ao fim da Tarefa, versionado, com origem e reversível.
- RF13 [DEC] Anexos guardados e entregues como arquivo; texto de PDFs e documentos indexado.

Agentes e execução
- RF14 [DEC] Orquestrador do sistema inicia Rodadas; o agente não "se serve" da fila.
- RF15 [DEC] Executor é interface própria; Hermes é o primeiro adaptador. Perfis de agente reutilizáveis, com complexidade sugerida no plano e confirmada na Aprovação.
- RF16 [DEC] Checkpoint próprio (ADR-0004); retomada e troca de modelo reconstroem a partir dele e do Workspace.
- RF17 [REQ] Uma Tarefa de execução tem exatamente um repositório principal modificável; outros repositórios são só leitura.
- RF18 [DEC] Workspace por git worktree (ADR-0002). Área prevista declarada no plano; avisos de sobreposição antes da Aprovação e durante a Rodada, sem bloquear.
- RF19 [REQ] Entrega por PR ou branch local, conforme configuração; a Tarefa vai a "Em validação" e só conclui com aceite humano.
- RF20 [REQ] Decisão de negócio ou ampliação de escopo durante a execução interrompe só a parte afetada e pede orientação.

Monitoramento
- RF21 [DEC] Coletores são código determinístico e agendado (padrão diário, sob demanda possível); primeiro Shopify mais fontes de métricas do site (ADR-0003).
- RF22 [DEC] Snapshot imutável por Coleta, visão consolidada, Revisões, Coleta idempotente, backfill de 90 dias, Lacunas recuperáveis, retentativas com backoff e respeito aos limites das APIs.
- RF23 [DEC] A análise por agente corre após Anomalia ou no fim do período configurado (ex.: semanal), além de sob demanda. Oportunidades viram Tarefas "Novo" com evidências.
- RF24 [DEC] Falha de Coleta só registra erro e Lacuna, exceto causas que exigem ação humana (ex.: credencial expirada): uma Tarefa "Novo" por causa.

Interfaces
- RF25 [DEC] API HTTP local como fonte única de verdade, com operações longas assíncronas; MCP para agentes sem ferramentas de aprovação; UI como projeto independente (ADR-0005).

## 3. Requisitos não funcionais

- Local-first: aplicação, banco e agentes na máquina do usuário; serviços externos só para modelos e integrações.
- Segurança: credenciais separadas humano/agente; tokens GitHub de escopo mínimo (ADR-0001); segredos fora de texto aberto no banco e no repositório, entregues só à Rodada que precisa, mascarados nos logs. Armazenamento [DEC]: variáveis de ambiente / arquivo `.env` (ADR-0007); keyring do sistema fica como melhoria futura.
- Resiliência: filas persistentes, retomada após falha ou reinício via Checkpoint.
- Rastreabilidade: por Rodada, comandos, arquivos alterados, testes, erros, modelo e provedor, skills e ferramentas, decisões, fontes, aprovações e tokens. Eventos no SQLite, saídas grandes em disco. Sem expurgo no MVP.
- Extensibilidade: runtime atrás do Executor; novas fontes como novos Coletores; interface mínima para evitar generalização precoce.
- Operação: daemon único com módulos de fronteira clara; agentes como processos filhos restritos.
- Implantação [REQ]: `docker compose up` sobe o sistema inteiro orquestrado (API/daemon, UI, MCP e dependências), com volumes persistentes para banco, anexos, logs e Workspaces, e configuração por variáveis de ambiente. Também deve ser possível rodar fora do Docker em desenvolvimento [SUG].
- Desempenho: sem metas rígidas; escala pequena (seção 1).

## 4. Entidades e relacionamentos

Contexto (árvore) 1—N Tarefa. Tarefa 1—N Subtarefa (auto-relação), N—N Dependência, 1—N Comentário, 1—N Aprovação, 1—N Rodada, N—1 repositório principal, N—N repositórios de consulta, 0..1 Perfil de agente sugerido. Rodada 1—N Segmento, 1—N Checkpoint, 1—N Evento de rastreio, 1—1 Workspace. Contexto 1—N versão de Contexto consolidado. Contexto 1—N Coletor 1—N Coleta 1—N Snapshot, Revisão, Lacuna. Anexo pertence a Tarefa ou Contexto. Credencial pertence ao escopo global ou a um Contexto.

## 5. Fluxos de trabalho

Exploração: Novo → Autorizada para explorar → Explorando ↔ Aguardando humano → Plano pronto para aprovação → Aprovado | Rejeitado.
Execução: Na fila → Em execução ↔ Aguardando humano → Em validação → Concluído.
Atalho humano: criação direta na Execução, com contrato mínimo (objetivo, repositório principal, critérios de aceitação). O humano escolhe o caminho e o sistema não o impõe.
Monitoramento: Coleta → Snapshot → comparação com histórico → Anomalia ou fim de período → Tarefa de análise → oportunidades como Tarefas "Novo".

## 6. Contratos humano-agente

- Agente pode: investigar, planejar, propor Subtarefas, comentar, decidir tecnicamente dentro do escopo aprovado, atualizar o Contexto consolidado.
- Agente não pode: aprovar, criar na Execução, alterar repositório fora do principal, ampliar o escopo, contornar restrições globais.
- Humano: autoriza exploração, aprova planos e execuções, aceita resultados, altera prioridade e perfil.
- Ambiguidade de negócio: o agente pergunta (Aguardando humano) e segue com o que for independente e seguro.
- Detalhamento da Tarefa proporcional a complexidade e risco: tarefas simples exigem mínimo; complexas explicitam objetivo, restrições, decisões, riscos, entregáveis e critérios.

## 7. Casos de uso

1. Backlog Shopify: Anomalia de conversão gera Tarefa "Novo" com evidências; o humano autoriza; o agente explora e propõe duas Subtarefas; uma é aprovada, outra rejeitada; a aprovada gera PR.
2. Projeto pessoal: o humano cria uma Tarefa, o agente propõe plano, o humano comenta ajustes, reaprova, e o agente abre PR.
3. Conflito paralelo: duas Tarefas declaram a mesma Área prevista; o aviso aparece antes da Aprovação.
4. Reinício: a máquina reinicia no meio de uma Rodada; uma nova Rodada parte do último Checkpoint.
5. Coleta falha: credencial expirada gera uma única Tarefa "Novo"; o período fica como Lacuna e é recuperado depois.

## 8. Critérios de aceitação

- Teste fim a fim (central): Tarefa em repositório pessoal → exploração → plano → Aprovação → PR em Workspace isolado → merge → Concluído, com histórico completo, tokens e Contexto consolidado atualizado. Depois, uma Coleta Shopify diária gera uma Tarefa "Novo".
- `docker compose up` em máquina limpa sobe API, UI e MCP; os dados sobrevivem a `down` e `up`.
- Nenhum token de agente consegue aprovar, tanto na API quanto no MCP.
- Recoletar o mesmo período não duplica dados e só gera Revisão se houver mudança.
- Mudança em campo-chave de plano aprovado devolve a Tarefa à Aprovação.
- Reverter versão do Contexto consolidado restaura a anterior sem apagar o histórico.
- Segredos não aparecem em logs nem no banco em texto aberto.
- Tarefa com dependência pendente não é iniciada sem "Forçar início".

## 9. Restrições e limites

Fora do MVP: dashboard de monitoramento e operacional, CLI, notificações automáticas, webhooks ou scripts como origem de Tarefas, quotas de tokens, backup, multiusuário, contêiner por Tarefa, embeddings, chat interativo.
Dentro, por decisão posterior: UI separada (ADR-0005).

## 10. Riscos e questões abertas

- Armazenamento de credenciais [DEC]: `.env` / variáveis de ambiente, por funcionar igual dentro e fora do Docker (ADR-0007). Keyring do sistema só como evolução.
- Interface do Executor: definir e registrar em ADR junto do primeiro adaptador (Hermes).
- Limiares de Anomalia: começar com poucos, fixos e configuráveis; calibrar com dados reais.
- Qualidade do Contexto consolidado: versão ruim contamina tarefas futuras; mitigação por reversão e origem rastreável. Avaliar revisão humana se ocorrer.
- Docker Compose x agentes [DEC]: agentes rodam dentro do container do daemon (ADR-0006), com repositórios e Workspaces em volumes e segredos injetados só na Rodada. A imagem precisa de git e do runtime do adaptador.
- Isolamento fraco do worktree: aceito no MVP; reavaliar contêiner (ADR-0002).
- Contrato mínimo de Tarefa criada direto na Execução: definido provisoriamente, sem bloqueio no MVP.
- Retomada é reconstrução, não continuação exata: pode repetir trabalho.

## 11. Alternativas arquiteturais

A. Daemon único TypeScript/Node + SQLite + UI SPA separada. Prós: reaproveita sua stack, simples, uma máquina. Contras: Node para orquestrar processos filhos exige cuidado com concorrência.
B. Daemon Python + SQLite. Prós: ecossistema de IA e Hermes. Contras: UI em outra linguagem; menos reaproveitamento.
C. Serviços separados (API, orquestrador, coletores) com Docker Compose. Prós: isolamento. Contras: complexidade e overhead desnecessários nesta escala. Observação: o Compose em si é requisito, mas não obriga a separar o daemon em vários serviços; a opção A empacotada no Compose (daemon + UI) atende.
D. Sistema embutido em Tauri (desktop). Prós: local-first nativo. Contras: acopla a UI ao daemon e foge de "UI independente".

## 12. Decisão arquitetural [DEC]

Opção A: daemon único em TypeScript/Node com SQLite (FTS para busca) e módulos separados por fronteira (API, orquestrador, coletores, Executor, contexto, rastreio); agentes como processos filhos restritos; Executor com adaptador Hermes; MCP e UI SPA como clientes da API. Alternativa B é razoável se a integração com o Hermes pesar mais que o reaproveitamento da stack. Decisão fechada no ADR-0007.

## 13. Estratégia de evolução

1. Núcleo: Tarefas, filas, Aprovação, comentários, Contextos, anexos, API, MCP e UI, com agentes operados manualmente.
2. Execução completa: orquestrador, Executor Hermes, Workspaces, Rodadas, Checkpoints, PR, rastreabilidade e Contexto consolidado.
3. Monitoramento Shopify: Coletores, Snapshots, Revisões, Lacunas, Anomalias e geração de Tarefas.
Depois do MVP, por demanda: contêiner por Tarefa, embeddings, dashboards, notificações, webhooks e outros runtimes.
