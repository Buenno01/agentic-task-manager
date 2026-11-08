import type { Contexto } from "../domain/contexto.ts";
import type { Tarefa } from "../domain/tarefa.ts";
import { ordenarPorPrioridade, type Prioridade } from "../domain/prioridade.ts";
import type { TipoRodada } from "../executor/executor.ts";

export const MAX_RODADAS_PADRAO = 2;
export const AUTOR_ORQUESTRADOR = "agente:orquestrador";

export interface OpcoesOrquestrador {
  /** Teto global de Rodadas simultâneas (padrão: ATM_MAX_RODADAS ou 2). */
  maxRodadas?: number;
  /** Agenda a varredura periódica e devolve o cancelamento. Injetável: os testes não esperam timers. */
  agendar?: (varrer: () => void) => () => void;
  /** Varre também a cada mudança de estado de Tarefa e ao fim de cada Rodada (padrão: sim). */
  aoMudarEstado?: boolean;
  /** Relógio em ms (injetável; o backoff de falhas (ADR-0004) usa este relógio). */
  relogio?: () => number;
}

export const INTERVALO_VARREDURA_MS = 15_000;

/** Varredura periódica real: setInterval que não segura o processo. */
export const agendarComTimer =
  (ms = INTERVALO_VARREDURA_MS) =>
  (varrer: () => void) => {
    const t = setInterval(varrer, ms);
    t.unref();
    return () => clearInterval(t);
  };

export function lerMaxRodadas(env: string | undefined): number {
  const n = Number(env);
  return env !== undefined && Number.isInteger(n) && n >= 1 ? n : MAX_RODADAS_PADRAO;
}

export interface DepsOrquestrador {
  tarefas(): Tarefa[];
  prioridade(id: string): Prioridade;
  contextos(): Contexto[];
  contextoDaTarefa(id: string): string | null;
  /** Rodadas em andamento (qualquer tipo). */
  emAndamento(): { tarefaId: string }[];
  /** Quantas Rodadas a Tarefa já teve. */
  totalRodadas(tarefaId: string): number;
  dependenciasPendentes(id: string): number;
  /** Houve "Forçar início" (humano) no histórico da Tarefa. */
  foiForcada(id: string): boolean;
  /** Move a Tarefa para o estado de andamento, registrando o orquestrador como autor. */
  marcarInicio(t: Tarefa, para: string, tipo: string): void;
  iniciarRodada(tarefaId: string, tipo: TipoRodada): Promise<unknown>;
  /** Tarefa em andamento, sem Rodada ativa, cuja última Rodada pede nova (falha com backoff vencido, interrompida, retomada). */
  precisaRetomar?(tarefaId: string, agoraMs: number): boolean;
}

interface Candidata {
  tarefa: Tarefa;
  tipo: TipoRodada;
  /** Verdadeiro quando o estado já é de andamento (Forçar início): só falta a Rodada. */
  jaEmAndamento: boolean;
}

/** Decide quais Tarefas aguardam uma Rodada e em que tipo. */
function candidatas(d: DepsOrquestrador, ordenadas: Tarefa[], agoraMs: number): Candidata[] {
  const out: Candidata[] = [];
  const comRodada = new Set(d.emAndamento().map((r) => r.tarefaId));
  for (const t of ordenadas) {
    if (
      (t.state === "Explorando" || t.state === "Em execução") &&
      !comRodada.has(t.id) &&
      d.totalRodadas(t.id) > 0 &&
      d.precisaRetomar?.(t.id, agoraMs)
    ) {
      out.push({ tarefa: t, tipo: t.phase === "Exploração" ? "Exploração" : "Execução", jaEmAndamento: true });
      continue;
    }
    if (t.phase === "Exploração" && t.state === "Autorizada para explorar") out.push({ tarefa: t, tipo: "Exploração", jaEmAndamento: false });
    else if (t.phase === "Execução" && t.state === "Na fila") out.push({ tarefa: t, tipo: "Execução", jaEmAndamento: false });
    else if (
      (t.state === "Explorando" || t.state === "Em execução") &&
      d.totalRodadas(t.id) === 0 &&
      d.foiForcada(t.id)
    )
      out.push({ tarefa: t, tipo: t.phase === "Exploração" ? "Exploração" : "Execução", jaEmAndamento: true });
  }
  return out;
}

/** Orquestrador: escolhe Tarefas por prioridade e depois chegada e inicia Rodadas dentro dos limites. */
export function criarOrquestrador(d: DepsOrquestrador, opcoes: OpcoesOrquestrador = {}) {
  const maxRodadas = opcoes.maxRodadas ?? lerMaxRodadas(process.env.ATM_MAX_RODADAS);
  const relogio = opcoes.relogio ?? Date.now;

  async function varrerUmaVez() {
    const ctxs = new Map(d.contextos().map((c) => [c.id, c]));
    const cadeia = (id: string | null): Contexto[] => {
      const out: Contexto[] = [];
      for (let c = id ? ctxs.get(id) : undefined; c; c = c.parentId ? ctxs.get(c.parentId) : undefined) out.unshift(c);
      return out;
    };
    // Contagem por Contexto: cada Rodada conta em todos os ancestrais (subárvore).
    const porContexto = new Map<string, number>();
    const contar = (tarefaId: string, delta: number) => {
      for (const c of cadeia(d.contextoDaTarefa(tarefaId))) porContexto.set(c.id, (porContexto.get(c.id) ?? 0) + delta);
    };
    let ativas = 0;
    for (const r of d.emAndamento()) {
      ativas++;
      contar(r.tarefaId, 1);
    }

    const ordenadas = ordenarPorPrioridade(d.tarefas().map((t) => ({ ...t, priority: d.prioridade(t.id) })));
    for (const c of candidatas(d, ordenadas, relogio())) {
      if (ativas >= maxRodadas) break;
      const t = c.tarefa;
      if (!d.foiForcada(t.id) && d.dependenciasPendentes(t.id) > 0) continue;
      // Limite do Contexto: todo ancestral com concurrencyLimit vale para a sua subárvore.
      const estoura = cadeia(d.contextoDaTarefa(t.id)).some(
        (ctx) => ctx.concurrencyLimit !== null && (porContexto.get(ctx.id) ?? 0) >= ctx.concurrencyLimit,
      );
      if (estoura) continue;
      if (!c.jaEmAndamento) d.marcarInicio(t, c.tipo === "Exploração" ? "Explorando" : "Em execução", c.tipo === "Exploração" ? "iniciar" : "iniciar-execucao");
      await d.iniciarRodada(t.id, c.tipo);
      ativas++;
      contar(t.id, 1);
    }
  }

  // Varreduras em fila: nunca duas ao mesmo tempo, para os limites não serem ultrapassados.
  let fila: Promise<void> = Promise.resolve();
  let parado = false;
  const varrer = (): Promise<void> => {
    if (parado) return Promise.resolve();
    const p = fila.then(varrerUmaVez);
    fila = p.catch((e) => void console.error("Falha na varredura do orquestrador:", e));
    return p.catch(() => {});
  };

  const cancelar = (opcoes.agendar ?? agendarComTimer())(() => void varrer());

  return {
    varrer,
    /** Chamado quando uma Tarefa muda de estado ou uma Rodada termina. */
    mudou: () => {
      if (opcoes.aoMudarEstado !== false) void varrer();
    },
    agora: relogio,
    maxRodadas,
    async parar() {
      parado = true;
      cancelar();
      await fila;
    },
  };
}
export type Orquestrador = ReturnType<typeof criarOrquestrador>;
