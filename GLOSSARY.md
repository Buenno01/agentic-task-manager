# Agentic Task Manager

Sistema local-first de um único usuário para gerenciar tarefas e projetos e orquestrar agentes de IA, com aprovação humana explícita antes de qualquer execução.

## Language

### Tarefas e filas

**Tarefa** (Task):
Unidade de trabalho única. Tem uma fase e, dentro dela, um estado. Pode ter Subtarefas.
_Avoid_: Ticket, issue, card

**Fase** (Phase):
Em qual das duas filas a Tarefa está: Exploração ou Execução.
_Avoid_: Lista, board

**Exploração** (Exploration):
Fase em que o agente investiga e planeja, sem alterar nada. É também a fila de planejamento: tudo que um agente cria nasce aqui.
_Avoid_: Planejamento (como nome da fase), discovery

**Execução** (Execution):
Fase em que o agente realiza o trabalho aprovado. Só se entra nela por aprovação humana ou por criação direta do humano.
_Avoid_: Implementação

**Subtarefa** (Subtask):
Tarefa vinculada a uma Tarefa-mãe. Criada pelo agente na Exploração, pode ser editada, aprovada, rejeitada ou ajustada individualmente, por edição direta ou por comentário na Subtarefa ou na mãe.
_Avoid_: Tarefa-filha, microtarefa

**Tarefa-mãe** (Parent task):
Tarefa que originou Subtarefas.

### Estados da Exploração

**Novo** (New):
Tarefa criada e aguardando revisão humana. Todo item vindo de monitoramento ou de agente entra aqui.

**Autorizada para explorar** (Cleared to explore):
O humano revisou a Tarefa e liberou o agente a investigar e planejar. Não autoriza alterar nada.
_Avoid_: Pronto para execução (nome antigo, colide com a Execução)

**Explorando** (Exploring):
Agente investigando e planejando.

**Aguardando humano** (Awaiting human):
O agente precisa de resposta, decisão ou esclarecimento. Vale também na Execução.
_Avoid_: Pronto para o humano

**Plano pronto para aprovação** (Plan ready):
Planejamento concluído, aguardando decisão humana sobre a execução.
_Avoid_: Pronto para o agente

**Aprovado** (Approved):
O humano aprovou explicitamente a execução do plano.

**Rejeitado** (Rejected):
Proposta recusada. Fica no histórico e pode ser reaberta manualmente.

### Estados da Execução

**Na fila** (Queued): execução aprovada, aguardando processamento.
**Em execução** (Running): agente executando.
**Em validação** (In validation): resultado entregue, aguardando aceite humano.
**Concluído** (Done): aceite humano dado, por exemplo merge do PR ou movimentação manual.

**Dependência** (Dependency):
Relação "B depende de A" entre Tarefas. É um bloqueio brando: a interface mostra um aviso explícito e o humano pode mover B para "Na fila" mesmo assim. O orquestrador segura B enquanto A estiver pendente, sem gastar tokens, a menos que o humano use **Forçar início** (ato registrado). Se A for rejeitada ou reaberta, B vai para "Aguardando humano" com o motivo.
_Avoid_: Bloqueio rígido

**Mudança material** (Material change):
Alteração em campo-chave de um plano aprovado (repositório principal, critérios de aceitação, entregáveis, permissões). Exige nova Aprovação. O agente também pode solicitar reaprovação por conta própria.

### Execuções do agente

**Rodada** (Run):
Cada tentativa de um agente trabalhar em uma Tarefa. Uma Tarefa pode ter várias. Falha ou reinício gera nova Rodada, partindo do último checkpoint da anterior.
_Avoid_: Execução (colide com a Fase), job, tentativa
_Nota_: o **tipo da Rodada** (Exploração ou Execução) é só o nome da Fase em que a Tarefa estava ao iniciá-la; não é um segundo conceito de "execução".

**Segmento** (Segment):
Trecho de uma Rodada com um mesmo modelo e provedor. Trocar de modelo no meio abre novo Segmento na mesma Rodada, com seu próprio registro de tokens.

**Checkpoint** (Checkpoint):
Registro próprio do sistema, escrito pelo agente nos marcos da Rodada: progresso, decisões, arquivos tocados e próximos passos. A retomada reconstrói o contexto a partir dele e do estado do Workspace; é reconstrução, não continuação exata.
_Avoid_: Sessão (estado interno do runtime)

**Executor** (Executor):
Interface do produto que inicia uma Rodada em um runtime de agentes e devolve eventos (passos, comandos, tokens, perguntas, entrega). Cada runtime, como o Hermes, entra como um adaptador.
_Avoid_: Runtime (o runtime fica atrás do Executor)

**Perfil de agente** (Agent profile):
Combinação reutilizável de modelo, provedor, instruções, skills, ferramentas e permissões padrão, com nível de complexidade baixo, médio ou alto. O plano sugere o perfil e o humano o confirma ao aprovar.

**Pacote inicial** (Starter pack):
Conjunto pequeno entregue no início da Rodada: Contexto consolidado, instruções do repositório e a Tarefa. O restante é buscado sob demanda por ferramentas de busca.

### Contexto

**Contexto** (Context):
Nó hierárquico (cliente, projeto, repositório, loja, ambiente) ao qual Tarefas se associam. Filhos herdam dos pais. Configurações estruturadas são sobrescritas pelo filho; instruções em texto se somam do mais geral ao mais específico, e em conflito vence o mais específico.

**Contexto consolidado** (Consolidated context):
Resumo compacto e versionado de decisões, regras e aprendizados de um Contexto, com referência às Tarefas de origem. Agentes o atualizam direto ao fim de uma Tarefa; cada versão pode ser revertida sem apagar o histórico.
_Avoid_: Memória, knowledge base

### Monitoramento

**Coletor** (Collector):
Componente do produto que busca dados de uma fonte (Shopify, GA4, Search Console, PageSpeed, CrUX) de forma determinística, sem IA. Declara fonte, credencial, frequência e parâmetros.
_Avoid_: Scraper, integração, plugin

**Coleta** (Collection):
Uma execução de um Coletor sobre um período, agendada ou sob demanda. Na primeira conexão faz backfill limitado (padrão 90 dias).

**Anomalia** (Anomaly):
Variação relevante detectada pela comparação simples da Coleta com o histórico. Aciona a análise por agente, assim como o fim de um período configurável (por exemplo semanal).

**Snapshot** (Snapshot):
Registro imutável do que uma Coleta obteve para um período. A visão consolidada do período aponta para o Snapshot mais recente.

**Revisão** (Revision):
Registro de que um período já coletado mudou na fonte, com valor anterior e novo. Recoletar um período é idempotente: não duplica, só gera Revisão se algo mudou.

**Lacuna** (Gap):
Período sem dados por falha de Coleta. Fica consultável pela API e pode ser recuperado depois. Quando só faltam algumas métricas (a Coleta foi parcial), é uma **Lacuna parcial**: o período tem Snapshot, e a Lacuna lista as métricas ausentes e a causa.

**Coleta parcial** (Partial collection):
Coleta que termina com sucesso, mas sem parte das métricas, por exemplo sessões e conversão quando o ShopifyQL falha ou a loja não tem analytics. Pedidos, receita e produtos são gravados; as métricas ausentes ficam explícitas como ausentes, nunca como zero, e o período entra como Lacuna parcial até uma recoleta completá-lo. A Anomalia não avalia métrica ausente.
_Avoid_: Coleta falha (a Coleta parcial conclui; falha é a que não grava Snapshot)

**Análise de monitoramento** (Monitoring analysis):
Tarefa de Exploração criada sozinha no Contexto do Coletor quando uma Anomalia é detectada ou um período fecha (padrão: semanal, segunda 07:00 no fuso da loja, analisando a semana anterior; também `mensal` ou `nenhum`), mesmo sem Anomalia. Nasce "Novo", prioridade média com justificativa automática, corpo de um template fixo somado às instruções do Contexto e Perfil de agente herdado dele. Havendo uma aberta do mesmo Coletor, Anomalias e fechamentos novos se anexam a ela como evidência. Com `analise_automatica` ligada no Coletor nasce "Autorizada para explorar": pré-autorização explícita e rastreável, só para Exploração; o agente continua sem aprovar nada. As oportunidades que o agente encontra entram como Tarefas "Novo".
_Avoid_: Relatório, dashboard

### Isolamento

**Workspace** (Workspace):
Cópia de trabalho isolada de um repositório (um `git worktree`) onde uma Rodada altera arquivos. Uma por Tarefa em execução.

**Área prevista** (Intended area):
Arquivos e áreas do repositório que o plano declara que vai tocar. O sistema a compara com a de outras Tarefas abertas do mesmo repositório e avisa sobre sobreposição antes da aprovação; a interseção real de arquivos durante a Rodada gera aviso adicional. Nenhum aviso bloqueia.

**Prioridade** (Priority):
Campo ordinal (baixa, média, alta, urgente) com justificativa em impacto, urgência e esforço. O agente sugere, o humano altera. O orquestrador inicia por prioridade e depois por ordem de chegada, dentro do limite de concorrência do Contexto.

### Interfaces

**API** (API):
API HTTP local. Núcleo das regras de negócio e fonte única de verdade.

**MCP** (MCP):
Adaptador para agentes sobre a API. Expõe ferramentas estruturadas e nenhuma de aprovação.

**UI mínima** (Minimal UI):
Projeto independente que consome apenas a API. É o lugar onde o humano opera as filas, comenta e aprova.
_Avoid_: Dashboard (não há dashboard de monitoramento no MVP)

### Pessoas e permissões

**Humano** (Human):
O único usuário do sistema. Só ele possui a permissão de aprovar.

**Aprovação** (Approval):
Autorização humana explícita e rastreável. Aprovar o plano não é aprovar a execução; são etapas independentes. Um agente nunca aprova a própria execução.

## Relationships

- Uma **Tarefa** está em exatamente uma **Fase** e um estado dessa fase.
- Um agente nunca cria Tarefas na fase de **Execução**; só na **Exploração**, no estado **Novo**.
- Um humano pode criar uma Tarefa direto na **Execução**, quando ela já estiver suficientemente especificada. Essa escolha é do humano e fica registrada.
- Uma **Tarefa-mãe** só se resolve quando todas as suas Subtarefas forem aprovadas ou rejeitadas; as aprovadas seguem sozinhas na Execução.
- Uma **Tarefa-mãe** pode converter-se em Execução ou gerar **Subtarefas**; em ambos os casos o histórico é preservado.
