# Coleta é código determinístico; a IA só analisa após Anomalia ou período

Os Coletores são código do produto, com contrato simples (fonte, credencial, frequência, parâmetros), sem plataforma de plugins. A Coleta roda diariamente e calcula variações contra o histórico; o agente de análise só é acionado diante de uma Anomalia ou do fim de um período configurável (por exemplo semanal), para não gastar tokens em dias sem novidade.

## Considered Options

- Analisar com IA após toda Coleta: mais simples, custa tokens todos os dias.
- Só sob demanda: perde oportunidades que ninguém pediu para procurar. A análise sob demanda continua existindo além do gatilho automático.
