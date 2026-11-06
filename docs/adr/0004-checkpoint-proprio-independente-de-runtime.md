# Checkpoint próprio e independente de runtime

O agente escreve Checkpoints leves (progresso, decisões, arquivos tocados, próximos passos) nos marcos da Rodada, e o sistema os guarda. A retomada após falha, reinício ou troca de modelo reconstrói o contexto a partir do último Checkpoint mais o estado git do Workspace. Isso mantém o produto independente de qualquer runtime, ao custo de a retomada ser uma reconstrução e não uma continuação exata.

## Considered Options

- Depender do mecanismo de sessão de cada runtime: retomada mais fiel, mas impede trocar de modelo ou runtime no meio e acopla o produto ao Hermes.
