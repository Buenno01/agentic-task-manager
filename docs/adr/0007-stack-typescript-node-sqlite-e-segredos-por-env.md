# Stack TypeScript/Node + SQLite, Hermes como único adaptador, segredos por .env

O daemon é um processo único em TypeScript/Node com SQLite (FTS5 para busca textual), com módulos de fronteira clara (API, orquestrador, coletores, Executor, contexto, rastreio). A UI é uma SPA em projeto separado e o MCP é cliente da API (ADR-0005). Tudo empacotado em Docker Compose (ADR-0006).

O Hermes é o único adaptador do Executor no MVP. A interface do Executor continua sendo própria (RF15), mas não se constroem outros adaptadores nem abstrações para runtimes hipotéticos.

Segredos entram por variáveis de ambiente ou arquivo `.env` (com `.env.example` sem valores reais), porque funciona igual dentro e fora do Docker. Continuam valendo: nunca em texto aberto no banco, nunca no repositório, mascarados nos logs, entregues só à Rodada que precisa (ADR-0001).

## Considered Options

- Daemon Python: melhor ecossistema de IA e proximidade com o Hermes, mas a UI e o restante da stack do usuário são TypeScript, e o Executor já isola o runtime.
- Keyring do sistema para segredos: não funciona dentro do container, que é onde o daemon roda (ADR-0006).

## Consequences

Trocar de linguagem depois do primeiro ticket sai caro. Segredos em `.env` ficam em texto no disco do host; aceito no MVP local-first de um único usuário. Keyring pode voltar como melhoria para o modo de desenvolvimento fora do Docker.
