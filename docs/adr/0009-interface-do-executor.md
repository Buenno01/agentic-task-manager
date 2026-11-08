# 0009 — Interface do Executor e adaptador Hermes

Status: aceito

## Contexto

O orquestrador inicia Rodadas (Exploração e Execução) sem conhecer o runtime do agente. Era preciso uma interface pequena o bastante para um adaptador falso determinístico (testes) e para o Hermes (produção), com garantias de segurança (ADR-0001, ADR-0008) e de recuperação (ADR-0004).

## Decisão

Interface em `daemon/src/executor/executor.ts`: `Executor.executar(entrada): Promise<void>`.

- **Entrada** (`EntradaRodada`): `rodadaId`, `tarefaId`, `tipo`, `workspace` (worktree git), `prompt` (tarefa + Contexto consolidado; na retomada, último Checkpoint e diff desde o SHA), `ambiente`, `sinal`, `sinalForcado`, `emitir`.
- **Falha = a promessa rejeita**; a Rodada fica "falhou" com a mensagem do erro. Cancelamento também rejeita ("Rodada cancelada").
- **Ambiente do processo do agente**: somente `PATH`/`HOME` + o `ambiente` da Rodada (`ATM_API_URL`, `ATM_MCP_URL`, `ATM_AGENT_TOKEN`; `GIT_ASKPASS`/`ATM_GIT_TOKEN` só em Execução com token do GitHub) + chaves do provedor do modelo. Nunca `process.env` inteiro (conteria `ATM_HUMAN_TOKEN` e `ATM_GITHUB_TOKEN`).
- **Cancelamento**: `sinal` equivale a SIGTERM; `sinalForcado` dispara 10 s depois e o adaptador envia SIGKILL.
- **Eventos** (`emitir`): `processo {pid}` logo após criar o processo (o daemon mata órfãos no boot); `segmento {modelo, provedor}` abre um Segmento de uso; `tokens {entrada, saida, chamadas?, custo?}` soma ao Segmento atual; `comando {comando, arquivos}` quando arquivos mudam (alimenta a Área prevista/sobreposição); demais eventos (`passo`, `pergunta`, `entrega`, `api`…) são livres. **Ausência de `tokens` = "uso desconhecido"**, nunca zero inventado.

### Adaptador Hermes (`daemon/src/executor/hermes.ts`)

Comando: `hermes chat --query-file <tmp> --format stream-json --in <workspace> --source tool [-m M] [--max-turns N] [--run-budget S] --yolo`. O prompt vai por arquivo (sem interpretação do shell); `--yolo` porque não há TTY para aprovações e o limite de segurança é o contêiner (ADR-0006). Ligado por `ATM_EXECUTOR=hermes`; sem isso continua "não configurado".

Tradução do stream-json (`hermes_cli/stream_json.py`): `system/init` abre o Segmento (modelo informado pelo Hermes); `text` acumula e vira um evento `passo` ao fechar o trecho; `tool_use` vira `ferramenta` e, para `terminal`, `write_file` e `patch`, também `comando`; `tool_result` vira `resultado_ferramenta`; `result` fecha tudo e, se `exit_code != 0` ou houver `error`, a promessa rejeita.

### Origem do uso de tokens

O uso vem do registro terminal `result.tokens` (`input`, `output`, `total`, `cache_read`, `cache_write`) do stream-json — totais da Rodada inteira, num único Segmento, sem `chamadas` nem `custo`. `--usage-file` só vale no modo `--oneshot` e **não** é usado. Se o processo morrer antes do `result` (SIGKILL, queda, orçamento estourado sem resultado), nenhum `tokens` é emitido e o uso fica "uso desconhecido". Verificado apenas lendo o código-fonte do Hermes e contra um stub; **não verificado numa execução real** — passo humano em `scripts/verificar-hermes.sh`. Consequência: uma Rodada retomada gera um Segmento por processo, mas o uso de um processo morto é perdido.

## Testes

`daemon/test/hermes.test.ts` roda o adaptador contra um stub (`test/fixtures/hermes-stub.mjs`) via `spawn` injetável. `daemon/test/executor-contrato.test.ts` roda o contrato sobre o falso sempre e sobre o Hermes real só com `ATM_TESTE_HERMES=1` (chama o modelo). `scripts/verificar-hermes.sh` faz uma Tarefa de exemplo ponta a ponta, também só com `ATM_TESTE_HERMES=1`.

## Consequências

- Novos runtimes exigem só um adaptador que respeite este contrato; o orquestrador não muda.
- A imagem do daemon passa a conter o Hermes (instalador oficial; base Debian em vez de Alpine) e fica maior; as chaves do provedor entram como variáveis do daemon e são repassadas apenas ao agente.
- O formato do stream-json do Hermes é dependência externa: mudanças nele quebram o adaptador (cobertas pelo contrato real, não pela suíte automática).
