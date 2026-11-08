import type { ArmazemArea } from "../db/area.ts";
import type { ArmazemContextos } from "../db/contextos.ts";
import type { Repositorio } from "../db/index.ts";
import { calcularAvisos, validarArea, type TarefaParaSobreposicao } from "../domain/area.ts";
import { resolverContexto } from "../domain/contexto.ts";
import type { Tarefa } from "../domain/tarefa.ts";
import { cadeia, type Resposta } from "./contextos.ts";

/** Área prevista (RF18) e aviso de sobreposição: não bloqueia nada, só informa. */
export function criarArea(repo: Repositorio, ctx: ArmazemContextos, area: ArmazemArea) {
  function repositorioDa(id: string): string | null {
    const cid = ctx.contextoDaTarefa(id);
    const c = cid ? ctx.obter(cid) : undefined;
    return c ? resolverContexto(cadeia(ctx, c)).repository : null;
  }
  function visao(): TarefaParaSobreposicao[] {
    const mapa = area.mapa();
    return repo.listarTarefas().map((t) => ({
      id: t.id, title: t.title, state: t.state, repository: repositorioDa(t.id), area: mapa.get(t.id) ?? [],
    }));
  }
  const avisos = (id: string) => {
    const todas = visao();
    const alvo = todas.find((t) => t.id === id);
    return alvo ? calcularAvisos(alvo, todas) : [];
  };
  return {
    /** Tarefas com repositório e Área prevista (base do aviso prévio e do aviso real). */
    visao,
    /** Acrescenta intendedArea e overlapWarnings a uma Tarefa. */
    decorar: <T extends { id: string }>(t: T) => ({ ...t, intendedArea: area.obter(t.id), overlapWarnings: avisos(t.id) }),
    /** Rotas /tarefas/:id/area-prevista e /tarefas/:id/sobreposicao; undefined se não for destas. */
    async rota(metodo: string, path: string, corpo: () => Promise<Record<string, unknown>>, autor: string): Promise<Resposta | undefined> {
      const m = path.match(/^\/tarefas\/([^/]+)\/(area-prevista|sobreposicao)$/);
      if (!m) return undefined;
      const t: Tarefa | undefined = repo.obterTarefa(m[1]);
      if (m[2] === "sobreposicao" && metodo === "GET")
        return t ? { status: 200, corpo: avisos(t.id) } : { status: 404, corpo: { error: "Não encontrado" } };
      if (m[2] === "area-prevista" && metodo === "PUT") {
        if (!t) return { status: 404, corpo: { error: "Não encontrado" } };
        const paths = validarArea((await corpo()).paths);
        if (t.state === "Aprovado" || t.state === "Rejeitado")
          return { status: 409, corpo: { error: `Área prevista não pode mudar em ${t.state}` } };
        area.definir(t.id, paths, autor, t.state);
        return { status: 200, corpo: this.decorar(t) };
      }
      return undefined;
    },
  };
}
