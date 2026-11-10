import { randomUUID } from "node:crypto";
import { ErroValidacao } from "./tarefa.ts";

export const TIPOS_CONTEXTO = ["cliente", "projeto", "repositorio", "loja", "ambiente"] as const;
export type TipoContexto = (typeof TIPOS_CONTEXTO)[number];

/** Configuração estruturada: `null` significa "herdar do pai". */
export interface ConfigContexto {
  repository: string | null;
  /** Repositórios de consulta (somente leitura nos Workspaces). */
  referenceRepositories: string[] | null;
  testCommands: string[] | null;
  concurrencyLimit: number | null;
  /** Como a Execução entrega: `branch-local` (padrão) ou `pr` (GitHub, ADR-0001). */
  deliveryMode: ModoEntrega | null;
}

export const MODOS_ENTREGA = ["branch-local", "pr"] as const;
export type ModoEntrega = (typeof MODOS_ENTREGA)[number];

export interface Contexto extends ConfigContexto {
  id: string;
  name: string;
  kind: TipoContexto;
  parentId: string | null;
  instructions: string;
  createdAt: string;
}

export interface InstrucaoResolvida {
  contextId: string;
  name: string;
  text: string;
}

export interface ContextoResolvido extends ConfigContexto {
  id: string;
  path: { id: string; name: string; kind: TipoContexto }[];
  /** Do mais geral ao mais específico; em conflito, a última (mais específica) vence. */
  instructions: InstrucaoResolvida[];
  instructionsText: string;
}

type Entrada = Record<string, unknown>;

function texto(v: unknown, campo: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ErroValidacao(`${campo} deve ser texto`);
  return v.trim() || null;
}

function config(e: Entrada): Partial<ConfigContexto> {
  const out: Partial<ConfigContexto> = {};
  if ("repository" in e) out.repository = texto(e.repository, "repository");
  if ("referenceRepositories" in e) {
    const v = e.referenceRepositories;
    if (v === null) out.referenceRepositories = null;
    else if (Array.isArray(v) && v.every((c) => typeof c === "string" && c.trim()))
      out.referenceRepositories = v.map((c: string) => c.trim());
    else throw new ErroValidacao("referenceRepositories deve ser uma lista de textos");
  }
  if ("testCommands" in e) {
    const v = e.testCommands;
    if (v === null) out.testCommands = null;
    else if (Array.isArray(v) && v.every((c) => typeof c === "string" && c.trim()))
      out.testCommands = v.map((c: string) => c.trim());
    else throw new ErroValidacao("testCommands deve ser uma lista de textos");
  }
  if ("concurrencyLimit" in e) {
    const v = e.concurrencyLimit;
    if (v === null) out.concurrencyLimit = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 1) out.concurrencyLimit = v;
    else throw new ErroValidacao("concurrencyLimit deve ser um inteiro >= 1");
  }
  if ("deliveryMode" in e) {
    const v = e.deliveryMode;
    if (v === null) out.deliveryMode = null;
    else if ((MODOS_ENTREGA as readonly unknown[]).includes(v)) out.deliveryMode = v as ModoEntrega;
    else throw new ErroValidacao(`deliveryMode inválido (use: ${MODOS_ENTREGA.join(", ")})`);
  }
  return out;
}

function nome(v: unknown): string {
  const n = typeof v === "string" ? v.trim() : "";
  if (!n) throw new ErroValidacao("O nome do Contexto é obrigatório");
  return n;
}

function tipo(v: unknown): TipoContexto {
  if (!(TIPOS_CONTEXTO as readonly unknown[]).includes(v))
    throw new ErroValidacao(`Tipo de Contexto inválido (use: ${TIPOS_CONTEXTO.join(", ")})`);
  return v as TipoContexto;
}

export function novoContexto(e: Entrada): Contexto {
  const c = config(e);
  return {
    id: randomUUID(),
    name: nome(e.name),
    kind: tipo(e.kind),
    parentId: texto(e.parentId, "parentId"),
    instructions: typeof e.instructions === "string" ? e.instructions : "",
    repository: c.repository ?? null,
    referenceRepositories: c.referenceRepositories ?? null,
    testCommands: c.testCommands ?? null,
    concurrencyLimit: c.concurrencyLimit ?? null,
    deliveryMode: c.deliveryMode ?? null,
    createdAt: new Date().toISOString(),
  };
}

/** Aplica uma edição parcial (nome, tipo, instruções e configuração). */
export function editarContexto(atual: Contexto, e: Entrada): Contexto {
  const novo = { ...atual, ...config(e) };
  if ("name" in e) novo.name = nome(e.name);
  if ("kind" in e) novo.kind = tipo(e.kind);
  if ("instructions" in e) {
    if (typeof e.instructions !== "string") throw new ErroValidacao("instructions deve ser texto");
    novo.instructions = e.instructions;
  }
  return novo;
}

/**
 * Resolve a herança. `cadeia` vai da raiz até o próprio Contexto.
 * Estruturado: o filho sobrescreve; campo nulo herda. Texto: soma do geral ao específico.
 */
export function resolverContexto(cadeia: Contexto[]): ContextoResolvido {
  const alvo = cadeia[cadeia.length - 1];
  const r: ContextoResolvido = {
    id: alvo.id,
    repository: null,
    referenceRepositories: null,
    testCommands: null,
    concurrencyLimit: null,
    deliveryMode: null,
    path: cadeia.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    instructions: [],
    instructionsText: "",
  };
  for (const c of cadeia) {
    if (c.repository !== null) r.repository = c.repository;
    if (c.referenceRepositories !== null) r.referenceRepositories = c.referenceRepositories;
    if (c.testCommands !== null) r.testCommands = c.testCommands;
    if (c.concurrencyLimit !== null) r.concurrencyLimit = c.concurrencyLimit;
    if (c.deliveryMode !== null) r.deliveryMode = c.deliveryMode;
    if (c.instructions.trim()) r.instructions.push({ contextId: c.id, name: c.name, text: c.instructions.trim() });
  }
  r.instructionsText = r.instructions.map((i) => i.text).join("\n\n");
  return r;
}
