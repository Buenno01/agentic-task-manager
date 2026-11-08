import { apenasHumano, rotuloAutor, type Autor } from "../auth/credenciais.ts";
import type { Comentarios } from "../db/comentarios.ts";
import type { Repositorio } from "../db/index.ts";
import type { ArmazemRodadas } from "../db/rodadas.ts";
import type { TipoRodada } from "../executor/executor.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import { validarArea } from "../domain/area.ts";
import type { Resposta } from "./contextos.ts";

export interface DepsRodadasApi {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  comentarios: Comentarios;
  iniciar(tarefaId: string, tipo: TipoRodada): Promise<unknown>;
  /** Grava o Checkpoint do agente com o SHA do HEAD do Workspace. */
  checkpointDoAgente(rodadaId: string, dados: { progresso: string; decisoes: string[]; arquivosTocados: string[]; proximosPassos: string[] }): Promise<unknown>;
  /** Falso quando o token `orquestrador` não está configurado. */
  orquestradorConfigurado: boolean;
  /** Grava a Área prevista (RF18) com evento no histórico. */
  definirArea(tarefaId: string, paths: string[], autor: string, estado: string): void;
  /** Tarefa com Área prevista e avisos de sobreposição. */
  decorar<T extends { id: string }>(t: T): T;
}

const NAO_ENCONTRADO: Resposta = { status: 404, corpo: { error: "Não encontrado" } };
const lista = (v: unknown, campo: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ErroValidacao(`${campo} deve ser lista de textos`);
  return v as string[];
};

/** Rodadas e as ações do agente (checkpoint, perguntar, entregar). Nenhuma delas aprova nada. */
export function rotaRodadas(
  d: DepsRodadasApi,
  metodo: string,
  path: string,
  autor: Autor,
  corpo: () => Promise<Record<string, unknown>>,
): Promise<Resposta> | undefined {
  const quem = rotuloAutor(autor);
  const mRodada = path.match(/^\/rodadas\/([^/]+)$/);
  if (mRodada && metodo === "GET") {
    return (async () => {
      const r = d.rodadas.obter(mRodada[1]);
      return r ? { status: 200, corpo: r } : NAO_ENCONTRADO;
    })();
  }
  const mPergunta = path.match(/^\/tarefas\/([^/]+)\/perguntas\/([^/]+)$/);
  if (mPergunta && metodo === "GET") {
    return (async () => {
      const p = d.comentarios.obter(mPergunta[2]);
      if (!p || p.tarefaId !== mPergunta[1] || p.tipo !== "pergunta") return NAO_ENCONTRADO;
      // A resposta do humano (a mais recente) é o que o agente lê para seguir.
      const resposta = d.comentarios.listar(p.tarefaId).filter((c) => c.tipo === "resposta" && c.respondeA === p.id).at(-1);
      return { status: 200, corpo: { id: p.id, texto: p.texto, resposta: resposta ?? null } };
    })();
  }
  const m = path.match(/^\/tarefas\/([^/]+)\/(rodadas|checkpoints?|perguntar|entregar)$/);
  if (!m) return undefined;
  const [, id, recurso] = m;
  const post = metodo === "POST";
  if (recurso === "checkpoints") {
    if (metodo !== "GET") return undefined;
    return (async () => (d.repo.obterTarefa(id) ? { status: 200, corpo: d.rodadas.checkpointsDaTarefa(id) } : NAO_ENCONTRADO))();
  }
  if (!((recurso === "rodadas" && (post || metodo === "GET")) || (recurso !== "rodadas" && post))) return undefined;

  return (async () => {
    const t = d.repo.obterTarefa(id);
    if (recurso === "rodadas" && post && !apenasHumano(autor)) return { status: 403, corpo: { error: "Apenas o humano pode fazer isso" } };
    if (!t) return NAO_ENCONTRADO;

    if (recurso === "rodadas" && metodo === "GET") return { status: 200, corpo: d.rodadas.listarDaTarefa(id) };

    if (recurso === "rodadas") {
      if (!d.orquestradorConfigurado) return { status: 503, corpo: { error: "Token do agente orquestrador não configurado" } };
      const explorando = t.phase === "Exploração" && ["Autorizada para explorar", "Explorando"].includes(t.state);
      const executando = t.phase === "Execução" && ["Na fila", "Em execução"].includes(t.state);
      if (!explorando && !executando) return { status: 409, corpo: { error: `Sem Rodada possível em ${t.phase} · ${t.state}` } };
      if (d.rodadas.ativaDaTarefa(id)) return { status: 409, corpo: { error: "A Tarefa já tem uma Rodada em andamento" } };
      const rodada = await d.iniciar(id, explorando ? "Exploração" : "Execução");
      return { status: 202, corpo: rodada };
    }

    if (recurso === "checkpoint") {
      const rodadaId = d.rodadas.ativaDaTarefa(id);
      if (!rodadaId) return { status: 409, corpo: { error: "Não há Rodada em andamento" } };
      const b = await corpo();
      if (typeof b.progresso !== "string" || !b.progresso.trim()) throw new ErroValidacao("progresso é obrigatório");
      const dados = {
        progresso: b.progresso.trim(),
        decisoes: lista(b.decisoes, "decisoes"),
        arquivosTocados: lista(b.arquivosTocados, "arquivosTocados"),
        proximosPassos: lista(b.proximosPassos, "proximosPassos"),
      };
      const cp = await d.checkpointDoAgente(rodadaId, dados);
      return { status: 201, corpo: cp };
    }

    const emAndamento = t.phase === "Exploração" ? "Explorando" : "Em execução";
    if (recurso === "perguntar") {
      const b = await corpo();
      if (typeof b.texto !== "string" || !b.texto.trim()) throw new ErroValidacao("texto é obrigatório");
      if (t.state !== emAndamento && t.state !== "Aguardando humano")
        return { status: 409, corpo: { error: `Não é possível perguntar em ${t.state}` } };
      const c = d.comentarios.inserir({ tarefaId: id, autor: quem, tipo: "pergunta", texto: b.texto.trim() });
      if (t.state === emAndamento)
        d.repo.transicionar(id, { autor: quem, tipo: "pedir-humano", de: t.state, para: "Aguardando humano", motivo: "Pergunta do agente" });
      return { status: 201, corpo: c };
    }

    // entregar: o agente só sinaliza que terminou; aprovar e aceitar seguem sendo do humano.
    if (t.state !== emAndamento && t.state !== "Aguardando humano")
      return { status: 409, corpo: { error: `Não é possível entregar em ${t.phase} · ${t.state}` } };
    const b = await corpo();
    const para = t.phase === "Exploração" ? "Plano pronto para aprovação" : "Em validação";
    const resumo = typeof b.resumo === "string" ? b.resumo.trim() : "";
    // Na Exploração a entrega traz o plano (comentário tipado "plano") e a Área prevista; valida antes de mudar qualquer coisa.
    let plano = "";
    let areaPrevista: string[] | undefined;
    if (t.phase === "Exploração") {
      if (b.plano !== undefined && typeof b.plano !== "string") throw new ErroValidacao("plano deve ser texto");
      plano = typeof b.plano === "string" ? b.plano.trim() : "";
      if (b.areaPrevista !== undefined) areaPrevista = validarArea(b.areaPrevista);
    }
    if (plano) d.comentarios.inserir({ tarefaId: id, autor: quem, tipo: "plano", texto: plano });
    if (areaPrevista) d.definirArea(id, areaPrevista, quem, t.state);
    d.repo.transicionar(id, { autor: quem, tipo: "entregar", de: t.state, para, motivo: resumo });
    return { status: 200, corpo: d.decorar({ ...t, state: para }) };
  })();
}
