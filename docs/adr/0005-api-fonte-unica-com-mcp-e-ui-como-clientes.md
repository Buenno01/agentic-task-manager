# A API é a única fonte de verdade; MCP e UI são clientes independentes

Nota: a forma da UI ("mínima", sem build) foi substituída pelo ADR-0010. O restante segue válido.

A API HTTP local concentra todas as regras de negócio. O MCP (para agentes) e uma UI mínima (para o humano, projeto separado) são clientes dela e não duplicam regra alguma. A UI mínima entra no MVP, ao contrário do escopo inicial que a deixava de fora, porque operar as filas só por API ou por um agente intermediário é impraticável. Aprovação só ocorre pela UI ou pela API com a credencial do humano; o MCP não expõe aprovação (ADR-0001), de modo que um agente que opere em nome do humano não consegue aprovar sem que ele veja o plano.

## Considered Options

- UI embutida no mesmo projeto da API: mais rápido de começar, mas mistura apresentação com regras e dificulta trocar de interface depois.
- Sem UI no MVP, só API e MCP: descartado pelo usuário.

## Consequences

A UI mínima precisa cobrir: filas e filtros, detalhe da Tarefa com comentários, aprovação, e ajuste de prioridade. Monitoramento visual e dashboard continuam fora do MVP.
