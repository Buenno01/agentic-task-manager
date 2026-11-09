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
  priority?: number | null;
  [campo: string]: unknown;
}

export const listarTarefas = () => api<Tarefa[]>("/tarefas");
