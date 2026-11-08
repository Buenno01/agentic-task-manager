# O processo do agente alcança o MCP pela rede do Compose, com o token `orquestrador`

Cada Rodada roda como processo filho do daemon (ADR-0006) e recebe no ambiente três variáveis: `ATM_API_URL` (a API do próprio daemon), `ATM_MCP_URL` (padrão `http://mcp:3100/mcp`, o serviço `mcp` do Compose, porta `ATM_MCP_PORT` interna 3100, caminho `/mcp`) e `ATM_AGENT_TOKEN` (o token do agente `orquestrador`). Nenhum token humano entra na Rodada. O autor no histórico é `agente:orquestrador`, o que separa Rodadas automáticas de agentes operados à mão.

O serviço `mcp` autentica o cliente com um único bearer (`ATM_AGENT_TOKEN` do próprio serviço). Por isso, no `.env`, esse valor **deve ser o token do `orquestrador`** em `ATM_AGENT_TOKENS` (`orquestrador:<token>`); o daemon recusa iniciar sem esse agente. Outros agentes continuam possíveis em `ATM_AGENT_TOKENS`, mas só falam com a API diretamente.

O MCP segue como cliente fino da API (ADR-0005): `checkpoint`, `perguntar` e `entregar` apenas repassam a API, e não existe ferramenta de aprovação (ADR-0001). A API recusa com 403 qualquer aprovação feita por token de agente, tanto pelo MCP quanto direto.

## Considered Options

- Processo do agente fala só com a API, sem MCP: mais simples, mas o runtime (Hermes) consome ferramentas MCP e a spec define o MCP como a interface do agente.
- Um MCP em stdio por Rodada, iniciado pelo daemon: dispensa a rede, mas duplica o servidor MCP dentro do daemon e foge do serviço `mcp` já publicado.
- Publicar o MCP no host e usar `host.docker.internal`: expõe o caminho do agente fora da rede interna do Compose.

## Consequences

Difícil de reverter porque o contrato do ambiente (`ATM_API_URL`, `ATM_MCP_URL`, `ATM_AGENT_TOKEN`) vira a interface com qualquer adaptador de Executor. Quem roda o daemon fora do Compose define `ATM_MCP_URL` explicitamente. O token do `orquestrador` é um segredo de longa duração compartilhado por daemon e `mcp`: o mascarador de segredos (ticket de rastreio) deve cobri-lo. Todas as Rodadas compartilham a mesma identidade; a distinção entre Rodadas vem do registro de Rodada, não do token.
