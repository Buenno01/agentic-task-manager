import { ErroValidacao } from "./tarefa.ts";

/** Contrato da Tarefa de execução (RF2, RF6, RF17). Campos-chave: mudança material exige nova Aprovação. */
export interface DadosExecucao {
  objetivo: string;
  repositorioPrincipal: string;
  criterios: string[];
  entregaveis: string[];
  permissoes: string[];
  /** Verdadeiro quando o humano foi à Execução sem concluir a Exploração (RF2). */
  puladaExploracao: boolean;
}

export const CAMPOS_CHAVE = ["repositorioPrincipal", "criterios", "entregaveis", "permissoes"] as const;

export const VAZIO: DadosExecucao = {
  objetivo: "",
  repositorioPrincipal: "",
  criterios: [],
  entregaveis: [],
  permissoes: [],
  puladaExploracao: false,
};

interface TransicaoExecucao {
  de: string[];
  para: string;
}

/** Ciclo da Execução (spec seção 5), movido manualmente pelo humano nesta etapa. */
export const TRANSICOES_EXECUCAO: Record<string, TransicaoExecucao> = {
  "iniciar-execucao": { de: ["Na fila"], para: "Em execução" },
  "aguardar-humano-execucao": { de: ["Em execução"], para: "Aguardando humano" },
  "retomar-execucao": { de: ["Aguardando humano"], para: "Em execução" },
  "validar-execucao": { de: ["Em execução"], para: "Em validação" },
  "concluir-execucao": { de: ["Em validação"], para: "Concluído" },
};

const texto = (v: unknown, campo: string): string => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ErroValidacao(`${campo} deve ser texto`);
  return v.trim();
};
const lista = (v: unknown, campo: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ErroValidacao(`${campo} deve ser lista de textos`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
};

/** Contrato mínimo: objetivo, repositório principal e critérios de aceitação. */
export function contratoDeExecucao(e: Record<string, unknown>, puladaExploracao: boolean): DadosExecucao {
  const d: DadosExecucao = {
    objetivo: texto(e.objetivo, "objetivo"),
    repositorioPrincipal: texto(e.repositorioPrincipal, "repositorioPrincipal"),
    criterios: lista(e.criterios, "criterios"),
    entregaveis: lista(e.entregaveis, "entregaveis"),
    permissoes: lista(e.permissoes, "permissoes"),
    puladaExploracao,
  };
  if (!d.objetivo) throw new ErroValidacao("O objetivo é obrigatório na Execução");
  if (!d.repositorioPrincipal) throw new ErroValidacao("O repositório principal é obrigatório na Execução");
  if (d.criterios.length === 0) throw new ErroValidacao("Ao menos um critério de aceitação é obrigatório na Execução");
  return d;
}

/** Aplica uma edição parcial e diz se houve mudança material (campo-chave com valor diferente). */
export function aplicarEdicao(atual: DadosExecucao, e: Record<string, unknown>): { novo: DadosExecucao; material: boolean } {
  const novo = { ...atual };
  if ("objetivo" in e) novo.objetivo = texto(e.objetivo, "objetivo");
  if ("repositorioPrincipal" in e) novo.repositorioPrincipal = texto(e.repositorioPrincipal, "repositorioPrincipal");
  if ("criterios" in e) novo.criterios = lista(e.criterios, "criterios");
  if ("entregaveis" in e) novo.entregaveis = lista(e.entregaveis, "entregaveis");
  if ("permissoes" in e) novo.permissoes = lista(e.permissoes, "permissoes");
  const material = CAMPOS_CHAVE.some((c) => JSON.stringify(novo[c]) !== JSON.stringify(atual[c]));
  return { novo, material };
}
