import type { Repositorio, EventoTarefa } from "../db/index.ts";
import type { ArmazemRodadas, Rodada } from "../db/rodadas.ts";

/** Falha, retentativa e reinício (spec seção 7; ADR-0004). Regras puras e recuperação de boot. */
export const MAX_FALHAS_SEGUIDAS = 3;
/** Espera após a 1ª, 2ª e 3ª falha seguida (a 3ª leva a Tarefa a "Aguardando humano", sem nova Rodada). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Tempo entre SIGTERM (sinal de aborto) e SIGKILL (sinal forçado). */
export const ESPERA_SIGKILL_MS = 10_000;

const REINICIAM_SEQUENCIA = new Set([
  "rodada-concluida",
  "rodada-cancelada",
  "retomar",
  "retomar-execucao",
  "autorizar",
  "aprovar",
  "reabrir",
  "converter-execucao",
  "mudanca-material",
]);

/** 401/403 do provedor ou da API: autorização, não adianta tentar de novo. */
export function erroDeAutorizacao(e: unknown): boolean {
  const o = e as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(o?.status ?? o?.statusCode);
  if (status === 401 || status === 403) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(HTTP|status)[ :]*40[13]\b|\b40[13] (Unauthorized|Forbidden)\b/i.test(msg);
}

/** Falhas seguidas na ordem do histórico. Interrupção (reinício) não conta nem zera; sucesso, cancelamento e ação do humano zeram. */
export function falhasSeguidas(eventos: Pick<EventoTarefa, "tipo">[]): number {
  let n = 0;
  for (const e of eventos) {
    if (e.tipo === "rodada-falhou") n++;
    else if (REINICIAM_SEQUENCIA.has(e.tipo)) n = 0;
  }
  return n;
}

/** Motivo para ir a "Aguardando humano" depois de uma falha, ou null se cabe nova tentativa. */
export function motivoAguardarHumano(falhas: number, autorizacao: boolean, erro: string): string | null {
  if (autorizacao) return `Erro de autorização (401/403), sem retentativa: ${erro}`;
  if (falhas >= MAX_FALHAS_SEGUIDAS) return `${falhas} falhas seguidas da Rodada; última: ${erro}`;
  return null;
}

export interface EntradaRetomada {
  ultima: Rodada | undefined;
  eventosTarefa: Pick<EventoTarefa, "tipo">[];
  agoraMs: number;
}

/** A Tarefa em andamento, sem Rodada ativa, deve ganhar nova Rodada agora? */
export function podeRetomar({ ultima, eventosTarefa, agoraMs }: EntradaRetomada): boolean {
  if (!ultima) return false;
  if (ultima.estado === "interrompida") return true;
  if (ultima.estado === "falhou") {
    const n = falhasSeguidas(eventosTarefa);
    // n === 0: o humano agiu depois da falha (ex.: retomou após "Aguardando humano"); recomeça já.
    if (n === 0) return true;
    if (n >= MAX_FALHAS_SEGUIDAS) return false;
    const falha = [...ultima.eventos].reverse().find((e) => e.tipo === "falha");
    const emMs = Number(falha?.dados.emMs);
    return !Number.isFinite(emMs) || agoraMs >= emMs + BACKOFF_MS[n - 1];
  }
  if (ultima.estado === "cancelada") {
    // Cancelada por mudança de estado: só recomeça depois que o humano retoma (nova Aprovação).
    const i = eventosTarefa.map((e) => e.tipo).lastIndexOf("rodada-cancelada");
    return eventosTarefa.slice(i + 1).some((e) => e.tipo === "retomar" || e.tipo === "retomar-execucao");
  }
  return false;
}

/** Mata o processo órfão de uma Rodada de um daemon anterior. */
export function matarOrfao(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export interface DepsRecuperacao {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  checkpointAutomatico(rodadaId: string, motivo: string): Promise<unknown>;
  matar?: (pid: number) => boolean;
}

/** Boot: Rodadas "em andamento" viram "interrompidas" (não contam como falha), órfãos morrem e o Workspace ganha Checkpoint. */
export async function recuperarInterrompidas(d: DepsRecuperacao): Promise<string[]> {
  const matar = d.matar ?? matarOrfao;
  const feitas: string[] = [];
  for (const { id } of d.rodadas.emAndamento()) {
    const r = d.rodadas.obter(id);
    if (!r) continue;
    const pids = r.eventos.filter((e) => e.tipo === "processo").map((e) => Number(e.dados.pid));
    const mortos = pids.filter((p) => matar(p));
    await d.checkpointAutomatico(id, "interrupção").catch(() => undefined);
    d.rodadas.finalizar(id, "interrompida", "Daemon reiniciado durante a Rodada");
    d.rodadas.registrarEvento(id, "interrompida", { motivo: "Daemon reiniciado", processosMortos: mortos });
    d.repo.registrarEvento(r.tarefaId, { autor: "sistema", tipo: "rodada-interrompida", motivo: `${r.id}: daemon reiniciado` });
    feitas.push(id);
  }
  return feitas;
}
