import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArmazemRodadas, Rodada } from "../db/rodadas.ts";
import type { Repositorio } from "../db/index.ts";
import type { Executor, EventoExecutor, TipoRodada } from "../executor/executor.ts";

const git = promisify(execFile);

export interface DepsRodada {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  executor: Executor;
  workspacesDir: string;
  mcpUrl: string;
  /** Token do agente `orquestrador` (nunca o humano). */
  tokenAgente: string;
  /** URL da API do próprio daemon (conhecida só depois do listen). */
  apiUrl: () => string;
}

const AUTOR = "agente:orquestrador";

/** Dispara Rodadas num Executor e grava Rodada, Segmentos e eventos. */
export function criarRodadas(d: DepsRodada) {
  const ativas = new Map<string, { abort: AbortController; fim: Promise<void> }>();

  async function prepararWorkspace(rodadaId: string): Promise<string> {
    // Placeholder do ticket 01: repositório git vazio por Rodada; o worktree real vem no ticket 03.
    const dir = join(d.workspacesDir, rodadaId);
    mkdirSync(dir, { recursive: true });
    await git("git", ["init", "-q"], { cwd: dir });
    await git("git", ["-c", "user.name=atm", "-c", "user.email=atm@atm.local", "commit", "-q", "--allow-empty", "-m", "início"], { cwd: dir });
    return dir;
  }

  return {
    async iniciar(tarefaId: string, tipo: TipoRodada): Promise<Rodada> {
      const workspace = await prepararWorkspace(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      const rodada = d.rodadas.criar({ tarefaId, tipo, workspace });
      d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-iniciada", motivo: `${tipo} (${rodada.id})` });
      const abort = new AbortController();
      const emitir = (e: EventoExecutor) => {
        if (e.tipo === "segmento") {
          const s = e.dados as { modelo: string; provedor: string };
          d.rodadas.abrirSegmento(rodada.id, { modelo: s.modelo, provedor: s.provedor });
        } else if (e.tipo === "tokens") d.rodadas.somarUso(rodada.id, e.dados as { entrada: number; saida: number });
        d.rodadas.registrarEvento(rodada.id, e.tipo, e.dados as Record<string, unknown>);
      };
      const fim = (async () => {
        try {
          await d.executor.executar({
            rodadaId: rodada.id,
            tarefaId,
            tipo,
            workspace,
            ambiente: { ATM_API_URL: d.apiUrl(), ATM_MCP_URL: d.mcpUrl, ATM_AGENT_TOKEN: d.tokenAgente },
            sinal: abort.signal,
            emitir,
          });
          d.rodadas.finalizar(rodada.id, "concluída");
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: "rodada-concluida", motivo: rodada.id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const cancelada = abort.signal.aborted;
          d.rodadas.finalizar(rodada.id, cancelada ? "cancelada" : "falhou", msg);
          d.repo.registrarEvento(tarefaId, { autor: AUTOR, tipo: cancelada ? "rodada-cancelada" : "rodada-falhou", motivo: msg });
        } finally {
          ativas.delete(rodada.id);
        }
      })();
      ativas.set(rodada.id, { abort, fim });
      return rodada;
    },
    /** Cancela as Rodadas em curso e espera terminarem (fechamento do daemon). */
    async encerrar() {
      const todas = [...ativas.values()];
      for (const a of todas) a.abort.abort();
      await Promise.all(todas.map((a) => a.fim));
    },
  };
}
