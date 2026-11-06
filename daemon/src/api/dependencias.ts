import { apenasHumano, type Autor } from "../auth/credenciais.ts";
import { abrirDependencias } from "../db/dependencias.ts";
import type { Repositorio } from "../db/index.ts";
import { criaCiclo, dependenciaPendente, ESTADOS_ATIVOS } from "../domain/dependencias.ts";
import { ErroValidacao, type Tarefa } from "../domain/tarefa.ts";

export type RespostaRota = { status: number; corpo?: unknown };

/** Ações que dependência pendente segura (Exploração, Execução e conversão). */
const ACOES_SEGURADAS = ["iniciar", "iniciar-execucao", "converter-execucao"];

const MOTIVO_CASCATA: Record<string, { tipo: string; verbo: string }> = {
  rejeitar: { tipo: "dependencia-rejeitada", verbo: "rejeitada" },
  reabrir: { tipo: "dependencia-reaberta", verbo: "reaberta" },
};

/** Dependências brandas (RF5): "B depende de A". Módulo isolado; o server só delega. */
export function abrirModuloDependencias(dbPath: string, repo: Repositorio) {
  const store = abrirDependencias(dbPath);
  const pendentes = (id: string) =>
    store
      .dependeDe(id)
      .map((d) => repo.obterTarefa(d))
      .filter((t): t is Tarefa => !!t && dependenciaPendente(t.state))
      .map((t) => ({ id: t.id, title: t.title, state: t.state }));

  return {
    /** Campos extras da Tarefa na API, incluindo o aviso de dependência pendente. */
    anexar: (id: string) => ({ dependeDe: store.dependeDe(id), dependenciasPendentes: pendentes(id) }),

    /**
     * Rotas /tarefas/:id/dependencias[/:a]; undefined se a rota não é daqui.
     * Declarar dependência é permitido ao agente (planejamento); remover é só do humano (config).
     */
    async rota(method: string, path: string, autor: Autor, corpo: () => Promise<Record<string, unknown>>): Promise<RespostaRota | undefined> {
      const m = path.match(/^\/tarefas\/([^/]+)\/dependencias(?:\/([^/]+))?$/);
      if (!m) return undefined;
      const [, b, a] = m;
      if (method === "POST" && !a) {
        if (!repo.obterTarefa(b)) return { status: 404, corpo: { error: "Não encontrado" } };
        const { dependeDe } = await corpo();
        if (typeof dependeDe !== "string" || !dependeDe) throw new ErroValidacao("dependeDe é obrigatório");
        if (!repo.obterTarefa(dependeDe)) return { status: 404, corpo: { error: "Tarefa da dependência não existe" } };
        if (b === dependeDe) throw new ErroValidacao("Uma Tarefa não pode depender de si mesma");
        if (store.dependeDe(b).includes(dependeDe)) throw new ErroValidacao("Dependência já declarada");
        if (criaCiclo(b, dependeDe, store.dependeDe)) throw new ErroValidacao("Dependência criaria um ciclo");
        store.adicionar(b, dependeDe);
        return { status: 201, corpo: { id: b, ...this.anexar(b) } };
      }
      if (method === "DELETE" && a) {
        if (!apenasHumano(autor)) return { status: 403, corpo: { error: "Apenas o humano pode fazer isso" } };
        return store.remover(b, a) ? { status: 204 } : { status: 404, corpo: { error: "Não encontrado" } };
      }
      return undefined;
    },

    /** Antes de iniciar/converter: dependência pendente segura a Tarefa; "forcar-inicio" exige pendência. */
    antes(t: Tarefa, acao: string): RespostaRota | undefined {
      const p = pendentes(t.id);
      if (ACOES_SEGURADAS.includes(acao) && p.length)
        return {
          status: 409,
          corpo: { error: "Dependência pendente: use Forçar início (humano) ou aguarde", dependenciasPendentes: p },
        };
      if (acao === "forcar-inicio" && !p.length)
        return { status: 409, corpo: { error: "Não há dependência pendente; use iniciar" } };
    },

    /** Depois de rejeitar/reabrir A: dependentes ativos vão para "Aguardando humano" com o motivo. */
    depois(a: Tarefa, acao: string, autor: string, motivo: string) {
      const c = MOTIVO_CASCATA[acao];
      if (!c) return;
      for (const id of store.dependentes(a.id)) {
        const b = repo.obterTarefa(id);
        if (!b || !ESTADOS_ATIVOS.includes(b.state)) continue;
        repo.transicionar(b.id, {
          autor,
          tipo: c.tipo,
          de: b.state,
          para: "Aguardando humano",
          motivo: `Dependência ${a.id} (${a.title}) foi ${c.verbo}${motivo ? `: ${motivo}` : ""}`,
        });
      }
    },

    close: () => store.close(),
  };
}
