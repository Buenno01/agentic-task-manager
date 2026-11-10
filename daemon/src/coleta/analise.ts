import { novaTarefa } from "../domain/tarefa.ts";
import { resolverContexto } from "../domain/contexto.ts";
import { agendaDoColetor } from "../domain/agenda.ts";
import { fechamentosPendentes, frequenciaDeFechamento, ultimoFechamento, type Fechamento } from "../domain/fechamento.ts";
import type { Coletor } from "../domain/coleta.ts";
import type { Anomalia } from "../db/anomalias.ts";
import type { ArmazemAnalises } from "../db/analise.ts";
import type { Repositorio } from "../db/index.ts";
import type { Comentarios } from "../db/comentarios.ts";
import type { Prioridades } from "../db/prioridade.ts";
import type { ArmazemContextos } from "../db/contextos.ts";
import { cadeia } from "../api/contextos.ts";

/** Autor das ações automáticas do Monitoramento no histórico da Tarefa (ADR-0001: rastreável). */
export const AUTOR_MONITORAMENTO = "monitoramento";

/** Template fixo do corpo da Tarefa de análise; as instruções do Contexto são somadas depois. */
export const TEMPLATE_ANALISE = [
  "Análise de monitoramento. Investigue com as ferramentas de monitoramento (Anomalias, séries por métrica, quebra por produto, Revisões e Lacunas).",
  "Proponha oportunidades como Subtarefas ou Tarefas Novo, cada uma com evidências.",
  "Não altere nada: só leitura sobre a Coleta, e nenhuma execução sem Aprovação do humano.",
  "Os gatilhos desta análise (Anomalias e fechamentos de período) estão nos comentários da Tarefa, como evidências.",
].join("\n");

export interface DepsAnalise {
  repo: Repositorio;
  ctx: ArmazemContextos;
  prios: Prioridades;
  coment: Comentarios;
  analises: ArmazemAnalises;
  relogio: () => number;
  /** Avisa o orquestrador de que há Tarefa nova/mudança de estado. */
  mudou?: () => void;
}

const EXPLICACAO_PRIORIDADE = {
  impacto: "Variação detectada pelo Monitoramento; impacto ainda não medido, a análise deve estimá-lo.",
  urgencia: "Gerada automaticamente: prioridade média até um humano reavaliar.",
  esforco: "Análise somente de leitura sobre dados já coletados; esforço baixo.",
};

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const textoAnomalia = (a: Anomalia) =>
  `Anomalia em ${a.metric} no dia ${a.period}: valor ${a.value}, base ${a.base} (média dos 4 mesmos dias da semana anteriores), variação ${pct(a.variation)}. Snapshot ${a.snapshotId}.`;
const textoFechamento = (f: Fechamento) =>
  `Fechamento ${f.frequencia}: analisar o período de ${f.de} a ${f.ate} (inclusive), mesmo sem Anomalia.`;

/**
 * Análise de monitoramento: Anomalia ou fechamento de período viram uma Tarefa de análise no Contexto do
 * Coletor (ou evidência numa Tarefa de análise aberta do mesmo Coletor). Perfil de agente e instruções vêm do Contexto.
 */
export function criarAnalise(d: DepsAnalise) {
  /** Tarefa de análise aberta (nem Concluída nem Rejeitada) do Coletor, a mais recente. */
  const aberta = (coletorId: string) =>
    d.analises
      .tarefasDoColetor(coletorId)
      .map((id) => d.repo.obterTarefa(id))
      .find((t) => t && t.state !== "Concluído" && t.state !== "Rejeitado");

  function criar(coletor: Coletor) {
    const contexto = d.ctx.obter(coletor.contextId);
    const instrucoes = contexto ? resolverContexto(cadeia(d.ctx, contexto)).instructionsText : "";
    const tarefa = novaTarefa({
      title: `Análise de monitoramento · ${contexto?.name ?? coletor.id}`,
      description: instrucoes ? `${TEMPLATE_ANALISE}\n\n## Instruções do Contexto\n\n${instrucoes}` : TEMPLATE_ANALISE,
    });
    d.repo.inserirTarefa(tarefa);
    d.ctx.associarTarefa(tarefa.id, coletor.contextId);
    d.analises.vincularTarefa(tarefa.id, coletor.id);
    d.prios.definir(tarefa.id, "média", EXPLICACAO_PRIORIDADE, "agente", AUTOR_MONITORAMENTO);
    if (coletor.automaticAnalysis)
      // Pré-autorização explícita e rastreável (ADR-0001/0003): só leva a Tarefa à Exploração, nunca à Execução.
      d.repo.transicionar(tarefa.id, {
        autor: AUTOR_MONITORAMENTO,
        tipo: "autorizar",
        de: "Novo",
        para: "Autorizada para explorar",
        motivo: "Pré-autorizada pelo Coletor (analise_automatica ligada)",
      });
    return tarefa.id;
  }

  /** Anexa a evidência à Tarefa de análise aberta do Coletor, criando-a se não houver. */
  function anexar(coletor: Coletor, texto: string) {
    const id = aberta(coletor.id)?.id ?? criar(coletor);
    d.coment.inserir({ tarefaId: id, autor: AUTOR_MONITORAMENTO, tipo: "comentario", texto });
    d.mudou?.();
  }

  return {
    /** Gancho de `DepsColetas.aoDetectarAnomalia`: nunca lança. */
    aoDetectarAnomalia(a: Anomalia, coletor: Coletor) {
      try {
        anexar(coletor, textoAnomalia(a));
      } catch (e) {
        console.error(`Falha ao criar a análise de Anomalia (${coletor.id}):`, e instanceof Error ? e.message : e);
      }
    },
    /**
     * Processa os fechamentos de período devidos (inclusive os perdidos com a máquina desligada, sem teto), todos
     * como evidência da mesma Tarefa de análise aberta. Na primeira passagem do Coletor só marca o último
     * fechamento já ocorrido: só valem os fechamentos posteriores à existência do Coletor.
     */
    processarFechamentos(coletor: Coletor) {
      const frequencia = frequenciaDeFechamento(coletor.params);
      if (frequencia === "nenhum") return;
      const { timezone } = agendaDoColetor(coletor.params);
      const ultima = d.analises.ultimoFechamento(coletor.id);
      if (ultima === undefined) {
        d.analises.registrarFechamento(coletor.id, ultimoFechamento(d.relogio(), timezone, frequencia).chave, new Date(d.relogio()));
        return;
      }
      for (const f of fechamentosPendentes(d.relogio(), timezone, frequencia, ultima)) {
        anexar(coletor, textoFechamento(f));
        d.analises.registrarFechamento(coletor.id, f.chave, new Date(d.relogio()));
      }
    },
  };
}
export type Analise = ReturnType<typeof criarAnalise>;
