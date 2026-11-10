# UI como SPA React com shadcn/ui, em vez de HTML puro

Status: aceito (substitui parcialmente o ADR-0005 no que diz respeito à forma da UI)

A UI deixa de ser "mínima", em HTML e JS puros sem build, e passa a ser uma SPA em projeto separado com inspiração em Linear e ClickUp. Stack: React, TypeScript, Vite, Tailwind, shadcn/ui (Radix), TanStack Query e TanStack Router, `cmdk` para a command palette. O objetivo é apoiar-se em bibliotecas prontas para entregar uma interface moderna mais rápido do que escrevê-la à mão. O restante do ADR-0005 continua valendo: a API é a única fonte de verdade, a UI não carrega regra de negócio e Aprovação só ocorre com a credencial do humano.

## Considered Options

- Manter HTML puro: zero build, mas cada tela moderna (lista agrupada, atalhos, command palette, painel lateral) seria escrita à mão.
- Svelte ou Vue: viáveis, mas o ecossistema de componentes prontos (shadcn/ui, Radix) é maior em React.

## Consequences

A UI passa a ter etapa de build: `ui/Dockerfile` e `server.js` servem o `dist/` e repassam `/api/*` ao daemon (sem CORS, token só no proxy de mesmo origin). Trocar de framework depois custa caro. Dashboard e monitoramento visual continuam fora do escopo. Aprovar por atalho de teclado sempre passa por diálogo de confirmação que mostra o plano e a Área prevista.
