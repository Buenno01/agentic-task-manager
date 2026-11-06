import { apenasHumano, rotuloAutor, type Autor } from "../auth/credenciais.ts";
import type { ArmazemExecucao } from "../db/execucao.ts";
import type { Repositorio } from "../db/index.ts";
import { aplicarEdicao, contratoDeExecucao, TRANSICOES_EXECUCAO } from "../domain/execucao.ts";
import { novaTarefa, type Tarefa } from "../domain/tarefa.ts";
import type { Resposta } from "./contextos.ts";

const NEGADO: Resposta = { status: 403, corpo: { error: "Apenas o humano pode fazer isso" } };
const NAO_ENCONTRADO: Resposta = { status: 404, corpo: { error: "Não encontrado" } };
const MOTIVO_PULOU = "Humano pulou a Exploração";

export interface DepsExecucao {
  repo: Repositorio;
  store: ArmazemExecucao;
  autor: Autor;
  metodo: string;
  path: string;
  corpo: () => Promise<Record<string, unknown>>;
  /** Guarda de dependências brandas (RF5), aplicada antes de iniciar/converter. */
  antes?: (t: Tarefa, acao: string) => Resposta | undefined;
}

/** Criação direta na Execução (RF2): só o humano; exige o contrato mínimo; registra a Exploração pulada. */
export function criarDiretoNaExecucao(store: ArmazemExecucao, autor: Autor, entrada: Record<string, unknown>): Tarefa {
  const dados = contratoDeExecucao(entrada, true);
  const base = novaTarefa(entrada);
  const tarefa: Tarefa = { ...base, phase: "Execução", state: "Na fila" };
  store.criarDireto(tarefa, dados, {
    autor: rotuloAutor(autor), tipo: "criar-execucao", de: "", para: "Na fila", motivo: MOTIVO_PULOU,
  });
  return tarefa;
}

/** Rotas de Execução e mudança material. Devolve undefined se a rota não for daqui. */
export function rotaExecucao(d: DepsExecucao): Promise<Resposta> | undefined {
  const m = d.path.match(/^\/tarefas\/([^/]+)\/([a-z-]+)$/);
  if (!m) return undefined;
  const [, id, nome] = m;
  const autor = rotuloAutor(d.autor);

  if (d.metodo === "POST" && nome === "converter-execucao") {
    return (async () => {
      if (!apenasHumano(d.autor)) return NEGADO;
      const t = d.repo.obterTarefa(id);
      if (!t) return NAO_ENCONTRADO;
      if (t.phase !== "Exploração" || t.state === "Rejeitado")
        return { status: 409, corpo: { error: `Não é possível converter: ${t.phase} · ${t.state}` } };
      const bloqueio = d.antes?.(t, "converter-execucao");
      if (bloqueio) return bloqueio;
      const dados = contratoDeExecucao(await d.corpo(), t.state !== "Aprovado");
      const motivo =
        t.state === "Aprovado" ? "Exploração concluída; plano aprovado convertido" : `${MOTIVO_PULOU} (estava em ${t.state})`;
      d.store.mover(id, "Execução", "Na fila", dados, { autor, tipo: "converter-execucao", de: t.state, para: "Na fila", motivo });
      return { status: 200, corpo: { ...t, phase: "Execução", state: "Na fila" } };
    })();
  }

  const tr = d.metodo === "POST" ? TRANSICOES_EXECUCAO[nome] : undefined;
  if (tr) {
    return (async () => {
      if (!apenasHumano(d.autor)) return NEGADO;
      const t = d.repo.obterTarefa(id);
      if (!t) return NAO_ENCONTRADO;
      if (t.phase !== "Execução" || !tr.de.includes(t.state))
        return { status: 409, corpo: { error: `Transição inválida: ${t.state} → ${tr.para}` } };
      const bloqueio = d.antes?.(t, nome);
      if (bloqueio) return bloqueio;
      const { motivo } = await d.corpo();
      d.repo.transicionar(id, { autor, tipo: nome, de: t.state, para: tr.para, motivo: typeof motivo === "string" ? motivo : "" });
      return { status: 200, corpo: { ...t, state: tr.para } };
    })();
  }

  if (nome === "execucao" && (d.metodo === "GET" || d.metodo === "PATCH")) {
    return (async () => {
      const t = d.repo.obterTarefa(id);
      if (d.metodo === "GET") return t ? { status: 200, corpo: d.store.obter(id) } : NAO_ENCONTRADO;
      // Agente pode propor mudança no plano (RF6), mas só na Exploração; na Execução só o humano.
      if (t && t.phase === "Execução" && !apenasHumano(d.autor)) return NEGADO;
      if (!t) return NAO_ENCONTRADO;
      const atual = d.store.obter(id);
      const { novo, material } = aplicarEdicao(atual, await d.corpo());
      const aprovadoOuExecucao = t.phase === "Execução" || t.state === "Aprovado";
      if (material && aprovadoOuExecucao) {
        d.store.mover(id, "Exploração", "Plano pronto para aprovação", novo, {
          autor, tipo: "mudanca-material", de: t.state, para: "Plano pronto para aprovação",
          motivo: "Mudança material: nova Aprovação necessária",
        });
        return { status: 200, corpo: { ...t, phase: "Exploração", state: "Plano pronto para aprovação" } };
      }
      d.store.salvar(id, novo);
      return { status: 200, corpo: novo };
    })();
  }
  return undefined;
}
