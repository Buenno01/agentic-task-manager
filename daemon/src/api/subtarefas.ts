import { apenasHumano, rotuloAutor, type Autor } from "../auth/credenciais.ts";
import { abrirSubtarefas } from "../db/subtarefas.ts";
import type { Repositorio } from "../db/index.ts";
import { decisaoDaAcao, resolucao } from "../domain/subtarefas.ts";
import { ErroValidacao, type Tarefa } from "../domain/tarefa.ts";
import type { Resposta } from "./contextos.ts";

/** Subtarefas (RF2/RF3): relação mãe→filha em tabela lateral. Módulo isolado; o server só delega. */
export function abrirModuloSubtarefas(dbPath: string, repo: Repositorio) {
  const store = abrirSubtarefas(dbPath);
  const registrar = (t: Tarefa, autor: string, tipo: string, motivo: string) =>
    repo.transicionar(t.id, { autor, tipo, de: t.state, para: t.state, motivo });
  const resolucaoDe = (maeId: string) => resolucao(store.daMae(maeId).map((s) => s.decisao));

  return {
    /** Campos extras da Tarefa na API: mãe, Subtarefas e situação de resolução. */
    anexar: (id: string) => ({
      maeId: store.obter(id)?.maeId ?? null,
      subtarefas: store.daMae(id).map((s) => {
        const t = repo.obterTarefa(s.id);
        return { id: s.id, title: t?.title ?? "", state: t?.state ?? "", decisao: s.decisao };
      }),
      resolucaoSubtarefas: resolucaoDe(id),
    }),

    /** Criação: agente cria Subtarefa só na Exploração, em "Novo". */
    avaliarCriacao(entrada: Record<string, unknown>, autor: Autor): { erro: Resposta } | { maeId: string | null } {
      if (entrada.parentId === undefined || entrada.parentId === null) return { maeId: null };
      if (typeof entrada.parentId !== "string" || !entrada.parentId) throw new ErroValidacao("parentId inválido");
      if (entrada.phase === "Execução") {
        if (!apenasHumano(autor)) return { erro: { status: 403, corpo: { error: "Agente não cria na Execução" } } };
        throw new ErroValidacao("Subtarefa nasce na Exploração, em Novo");
      }
      if (!repo.obterTarefa(entrada.parentId)) return { erro: { status: 404, corpo: { error: "Tarefa-mãe não existe" } } };
      return { maeId: entrada.parentId };
    },

    vincular(sub: Tarefa, maeId: string, autor: Autor) {
      store.vincular(sub.id, maeId);
      const mae = repo.obterTarefa(maeId)!;
      registrar(mae, rotuloAutor(autor), "subtarefa-criada", `Subtarefa ${sub.id} (${sub.title})`);
    },

    /** Antes de uma transição: "aprovar-subtarefa" vale só para Subtarefa. */
    antes(t: Tarefa, acao: string): Resposta | undefined {
      if (acao === "aprovar-subtarefa" && !store.obter(t.id))
        return { status: 409, corpo: { error: "Apenas Subtarefas podem ser aprovadas assim" } };
    },

    /** Depois de uma transição: registra a decisão e, se a mãe acabou de se resolver, o evento. */
    depois(t: Tarefa, acao: string, autor: string) {
      const sub = store.obter(t.id);
      const d = decisaoDaAcao(acao);
      if (!sub || d === undefined) return;
      const antes = resolucaoDe(sub.maeId).resolvida;
      store.definirDecisao(t.id, d);
      const mae = repo.obterTarefa(sub.maeId);
      if (mae && !antes && resolucaoDe(sub.maeId).resolvida)
        registrar(mae, autor, "mae-resolvida", "Todas as Subtarefas foram aprovadas ou rejeitadas");
    },

    /** PATCH /tarefas/:id — o humano edita uma Subtarefa. */
    async editar(id: string, autor: Autor, corpo: () => Promise<Record<string, unknown>>): Promise<Resposta> {
      if (!apenasHumano(autor)) return { status: 403, corpo: { error: "Apenas o humano pode fazer isso" } };
      const t = repo.obterTarefa(id);
      if (!t) return { status: 404, corpo: { error: "Não encontrado" } };
      if (!store.obter(id)) return { status: 409, corpo: { error: "Só Subtarefas são editáveis aqui" } };
      const e = await corpo();
      const title = e.title === undefined ? t.title : typeof e.title === "string" ? e.title.trim() : "";
      if (!title) throw new ErroValidacao("O título da Tarefa é obrigatório");
      if (e.description !== undefined && typeof e.description !== "string") throw new ErroValidacao("description deve ser texto");
      const description = (e.description as string | undefined) ?? t.description;
      store.editar(id, title, description);
      registrar(t, rotuloAutor(autor), "editar", "Subtarefa editada");
      return { status: 200, corpo: { ...t, title, description } };
    },

    close: () => store.close(),
  };
}
