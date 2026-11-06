# Agentes usam credenciais próprias de escopo mínimo e nunca podem aprovar

O sistema é de um único usuário; a separação humano/agente é feita por credencial, não por contas. O token da API do humano tem a permissão de aprovar; cada agente recebe um token sem ela, e o MCP não expõe ferramentas de aprovação. No GitHub, o agente usa um token fine-grained por repositório (push de branch e abrir PR, sem merge nem exclusão), não o login pessoal do humano. Assim "agente nunca aprova a própria execução" vale também fora do sistema.

## Considered Options

- Usar `git`/`gh` com o login pessoal: mais simples, mas uma Rodada com defeito poderia fazer merge ou apagar sem aprovação.
- Contas e papéis multiusuário: descartado, excesso para um usuário só.
