# Workspaces são git worktrees; contêiner fica fora do MVP

Cada Tarefa em execução recebe um `git worktree` próprio, e o agente roda como processo restrito, sem acesso ao home do usuário. Escolhido por ser leve e suficiente para a escala esperada (poucos agentes simultâneos). A fronteira de segurança real é a credencial mínima (ADR-0001) e o escopo de arquivos, não um contêiner.

## Considered Options

- Contêiner/VM por Tarefa: isolamento maior, mas mais pesado de operar. Reavaliar se o agente precisar rodar código não confiável ou se aparecerem interferências entre dependências de Tarefas.

## Consequences

Tarefas do mesmo repositório compartilham a máquina e portas/serviços locais; conflitos de ambiente (não só de arquivos) precisam aparecer como risco no planejamento.
