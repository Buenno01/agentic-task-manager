// Cliente tipado da API do daemon. Sem regra de negócio: só transporte, auth Bearer e erros tipados.

export const TOKEN_KEY = "atm-token";

/** Base da API. Mesmo origin em /api (proxy do Vite em dev, de server.js em produção); sobrescreva com VITE_API_BASE. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "/api";

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const saveToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Resposta HTTP de erro (4xx/5xx). `message` vem de `{ error }` do daemon quando houver. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/** Falha de rede: daemon fora do ar ou inalcançável. */
export class NetworkError extends Error {}
/** Chamada feita sem token salvo (não chega a sair para a rede). */
export class MissingTokenError extends Error {}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new MissingTokenError("Token ausente");
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new NetworkError("Não foi possível conectar à API");
  }
  if (!res.ok) {
    const corpo = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, corpo?.error ?? `Erro ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// Tipos espelham daemon/src/domain/tarefa.ts (GET /tarefas); campos extras do daemon são aditivos.
export type Fase = "Exploração" | "Execução";
export interface Tarefa {
  id: string;
  title: string;
  description: string;
  phase: Fase;
  state: string;
  createdAt: string;
  contextId?: string | null;
  priority?: Prioridade | null;
  [campo: string]: unknown;
}

export const NIVEIS = ["baixa", "média", "alta", "urgente"] as const;
export type Nivel = (typeof NIVEIS)[number];
/** Prioridade vigente (daemon/src/domain/prioridade.ts); `origem` diz quem a definiu. */
export interface Prioridade {
  nivel: Nivel;
  origem?: string;
  [campo: string]: unknown;
}

export const listarTarefas = () => api<Tarefa[]>("/tarefas");
export const criarTarefa = (t: { title: string; description?: string; contextId?: string }) =>
  api<Tarefa>("/tarefas", { method: "POST", body: t });
/** O humano define só o nível; a justificativa é opcional para ele. */
export const definirPrioridade = (id: string, nivel: Nivel) =>
  api<Prioridade>(`/tarefas/${id}/prioridade`, { method: "PUT", body: { nivel } });

// Contextos (daemon/src/domain/contexto.ts). Herança e consolidação são do daemon; a UI só exibe.
export const TIPOS_CONTEXTO = ["cliente", "projeto", "repositorio", "loja", "ambiente"] as const;
export type TipoContexto = (typeof TIPOS_CONTEXTO)[number];

export interface Contexto {
  id: string;
  name: string;
  kind: TipoContexto;
  parentId: string | null;
  instructions: string;
  repository: string | null;
  testCommands: string[] | null;
  concurrencyLimit: number | null;
  createdAt: string;
  [campo: string]: unknown;
}
export type ContextoNo = Contexto & { children: ContextoNo[] };

export interface ContextoResolvido {
  id: string;
  path: { id: string; name: string; kind: TipoContexto }[];
  repository: string | null;
  testCommands: string[] | null;
  concurrencyLimit: number | null;
  instructions: { contextId: string; name: string; text: string }[];
  instructionsText: string;
  [campo: string]: unknown;
}

export interface ContextoConsolidado {
  contextId: string;
  version: number;
  text: string;
  createdAt: string | null;
  [campo: string]: unknown;
}

export interface NovoContexto {
  name: string;
  kind: TipoContexto;
  parentId?: string;
  repository?: string;
  testCommands?: string[];
  concurrencyLimit?: number;
  instructions?: string;
}

export const listarArvore = () => api<ContextoNo[]>("/contextos/arvore");
export const criarContexto = (c: NovoContexto) => api<Contexto>("/contextos", { method: "POST", body: c });
export const obterResolvido = (id: string) => api<ContextoResolvido>(`/contextos/${id}/resolvido`);
export const obterConsolidado = (id: string) => api<ContextoConsolidado>(`/contextos/${id}/consolidado`);
export const listarTarefasDoContexto = (id: string, subarvore = true) =>
  api<Tarefa[]>(`/contextos/${id}/tarefas${subarvore ? "?subarvore" : ""}`);
