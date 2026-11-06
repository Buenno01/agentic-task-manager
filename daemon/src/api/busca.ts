import type { ArmazemBusca } from "../db/busca.ts";
import type { ArmazemAnexos } from "../db/anexos.ts";
import type { ArmazemConsolidado } from "../db/consolidado.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import type { Resposta } from "./contextos.ts";

export type TipoResultado = "tarefa" | "comentario" | "consolidado" | "anexo";

export interface ResultadoBusca {
  tipo: TipoResultado;
  /** Id da fonte: Tarefa, comentário, anexo; no consolidado, o id do Contexto. */
  id: string;
  snippet: string;
  taskId: string | null;
  contextId: string | null;
  /** Só no consolidado: versão que casou. */
  version?: number;
}

export interface DepsBusca {
  busca: ArmazemBusca;
  anexos: ArmazemAnexos;
  consolidado: ArmazemConsolidado;
  contextoExiste(id: string): boolean;
  /** Pares (id, pai) de todos os Contextos, para expandir a subárvore. */
  contextos(): { id: string; parentId: string | null }[];
  contextoDaTarefa(tarefaId: string): string | null;
}

const LIMITE_POR_TIPO = 100;

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Trecho com as palavras da consulta entre [colchetes], mantendo grafia original do texto. */
export function trechoDe(texto: string, consulta: string): string {
  const termos = new Set((consulta.match(/[\p{L}\p{N}_]+/gu) ?? []).map(normalizar));
  const palavras = [...texto.matchAll(/[\p{L}\p{N}_]+/gu)];
  const primeira = palavras.find((p) => termos.has(normalizar(p[0])));
  const centro = primeira?.index ?? 0;
  const ini = Math.max(0, centro - 60);
  const fim = Math.min(texto.length, centro + 100);
  let out = "";
  let pos = ini;
  for (const p of palavras) {
    if (p.index < ini || p.index + p[0].length > fim) continue;
    out += texto.slice(pos, p.index);
    out += termos.has(normalizar(p[0])) ? `[${p[0]}]` : p[0];
    pos = p.index + p[0].length;
  }
  out += texto.slice(pos, fim);
  return (ini > 0 ? "…" : "") + out + (fim < texto.length ? "…" : "");
}

function subarvore(todos: { id: string; parentId: string | null }[], raiz: string): Set<string> {
  const ids = new Set([raiz]);
  for (let mudou = true; mudou; ) {
    mudou = false;
    for (const c of todos) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) ids.add(c.id), (mudou = true);
  }
  return ids;
}

/** GET /busca?q=…&contexto=<id>[&subarvore=1]. Devolve undefined quando a rota não é daqui. */
export function rotaBusca(d: DepsBusca, metodo: string, path: string, query: URLSearchParams): Resposta | undefined {
  if (path !== "/busca" || metodo !== "GET") return undefined;
  const q = query.get("q") ?? "";
  if (!/[\p{L}\p{N}]/u.test(q)) throw new ErroValidacao("Consulta (q) é obrigatória");
  const contexto = query.get("contexto");
  let permitidos: Set<string> | null = null;
  if (contexto) {
    if (!d.contextoExiste(contexto)) throw new ErroValidacao("Contexto não existe");
    const sub = query.get("subarvore");
    permitidos = sub === "1" || sub === "true" ? subarvore(d.contextos(), contexto) : new Set([contexto]);
  }
  const passa = (r: ResultadoBusca) => !permitidos || (r.contextId !== null && permitidos.has(r.contextId));
  const cap = (rs: ResultadoBusca[]) => rs.filter(passa).slice(0, LIMITE_POR_TIPO);

  const tarefas = cap(
    d.busca.tarefas(q).map((a) => ({ tipo: "tarefa", id: a.id, snippet: a.trecho, taskId: a.tarefaId, contextId: d.contextoDaTarefa(a.tarefaId) })),
  );
  const comentarios = cap(
    d.busca.comentarios(q).map((a) => ({ tipo: "comentario", id: a.id, snippet: a.trecho, taskId: a.tarefaId, contextId: d.contextoDaTarefa(a.tarefaId) })),
  );
  const consolidado = cap(
    d.consolidado.buscar(q).map((a) => ({ tipo: "consolidado", id: a.contextId, snippet: a.trecho, taskId: null, contextId: a.contextId, version: a.version })),
  );
  const anexos = cap(
    d.anexos.buscar(q).map((a) => ({
      tipo: "anexo",
      id: a.id,
      snippet: trechoDe(d.anexos.texto(a.id) ?? "", q),
      taskId: a.ownerType === "tarefa" ? a.ownerId : null,
      contextId: a.ownerType === "tarefa" ? d.contextoDaTarefa(a.ownerId) : a.ownerId,
    })),
  );
  return { status: 200, corpo: [...tarefas, ...comentarios, ...consolidado, ...anexos] };
}
