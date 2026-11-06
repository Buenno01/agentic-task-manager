# Agentes rodam dentro do container do daemon, orquestrados por Docker Compose

O sistema sobe inteiro com `docker compose up`, e as Rodadas dos agentes executam dentro do container do daemon, não no host. Repositórios e Workspaces ficam em volumes montados, e as credenciais são injetadas só na Rodada que precisa (ADR-0001). O agente não enxerga o home do usuário, o que reforça o isolamento do ADR-0002 sem exigir um contêiner por Tarefa. A imagem precisa incluir git e o runtime do adaptador (Hermes).

## Considered Options

- Agentes no host, Compose só para API, UI e MCP: acesso fácil aos repositórios e credenciais locais, mas o Compose deixa de subir "tudo" e o agente enxerga arquivos fora do escopo.

## Consequences

O ADR-0002 continua válido (worktree por Tarefa), agora dentro do container. Todas as Rodadas compartilham o mesmo container e a mesma rede; um contêiner por Tarefa segue como evolução. Repositórios precisam ser montados ou clonados em volume, o que os tickets da etapa 2 devem tratar.
