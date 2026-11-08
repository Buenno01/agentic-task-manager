import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Tarefa } from "../domain/tarefa.ts";
import type { Workspaces } from "../workspace/workspace.ts";
import type { Resposta } from "./contextos.ts";

/** Estados terminais: a Tarefa não precisa mais do Workspace (a branch `atm/<id>` fica no clone). */
const TERMINAIS = ["Concluído", "Rejeitado"];

export interface DepsWorkspaces {
  workspaces: Workspaces;
  workspacesDir: string;
  obterTarefa: (id: string) => Tarefa | undefined;
  /** Há Rodada em andamento na Tarefa? */
  rodadaAtiva: (id: string) => boolean;
}

/**
 * Órfão: diretório de Workspace SEM dono vivo, isto é,
 *  - a Tarefa não existe mais; ou
 *  - a Tarefa está em estado terminal (Concluído ou Rejeitado) e não há Rodada em andamento.
 * Qualquer outro caso (inclusive "Aguardando humano" e "Em validação") é Workspace em uso e nunca é removido.
 */
export function ehOrfao(d: DepsWorkspaces, tarefaId: string): boolean {
  if (d.rodadaAtiva(tarefaId)) return false;
  const t = d.obterTarefa(tarefaId);
  return !t || TERMINAIS.includes(t.state);
}

/** Bytes ocupados em disco (blocos alocados; não segue links simbólicos). */
function bytesDe(caminho: string): number {
  const st = lstatSync(caminho);
  let total = st.blocks * 512;
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let nomes: string[] = [];
    try {
      nomes = readdirSync(caminho);
    } catch {}
    for (const n of nomes) total += bytesDe(join(caminho, n));
  }
  return total;
}

function listar(d: DepsWorkspaces) {
  if (!existsSync(d.workspacesDir)) return [];
  return readdirSync(d.workspacesDir)
    .filter((n) => lstatSync(join(d.workspacesDir, n)).isDirectory())
    .sort()
    .map((tarefaId) => ({
      tarefaId,
      estado: d.obterTarefa(tarefaId)?.state ?? null,
      bytes: bytesDe(join(d.workspacesDir, tarefaId)),
      orfao: ehOrfao(d, tarefaId),
    }));
}

/** Concluir/rejeitar: remove o worktree se a Tarefa ficou em estado terminal (a branch é preservada). */
export async function liberarSeTerminal(d: DepsWorkspaces, tarefaId: string): Promise<void> {
  if (ehOrfao(d, tarefaId) && d.obterTarefa(tarefaId)) await d.workspaces.remover(tarefaId);
}

export function rotaWorkspaces(d: DepsWorkspaces, metodo: string, path: string, humano: boolean): Promise<Resposta> | undefined {
  if (path === "/workspaces" && metodo === "GET")
    return (async () => {
      const lista = listar(d);
      return { status: 200, corpo: { workspaces: lista, totalBytes: lista.reduce((s, w) => s + w.bytes, 0) } };
    })();
  if (path === "/workspaces/limpar" && metodo === "POST")
    return (async () => {
      if (!humano) return { status: 403, corpo: { error: "Apenas o humano pode fazer isso" } };
      const removidos: { tarefaId: string; bytes: number }[] = [];
      for (const w of listar(d)) {
        if (!w.orfao) continue;
        await d.workspaces.remover(w.tarefaId);
        removidos.push({ tarefaId: w.tarefaId, bytes: w.bytes });
      }
      return { status: 200, corpo: { removidos, bytesLiberados: removidos.reduce((s, w) => s + w.bytes, 0) } };
    })();
  return undefined;
}
