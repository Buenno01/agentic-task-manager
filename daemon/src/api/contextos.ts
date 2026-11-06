import type { ArmazemContextos } from "../db/contextos.ts";
import {
  editarContexto,
  novoContexto,
  resolverContexto,
  type Contexto,
} from "../domain/contexto.ts";
import { ErroValidacao } from "../domain/tarefa.ts";

export interface Resposta {
  status: number;
  corpo?: unknown;
}
const ok = (corpo: unknown, status = 200): Resposta => ({ status, corpo });
const naoEncontrado: Resposta = { status: 404, corpo: { error: "Não encontrado" } };

/** Cadeia da raiz até o Contexto. */
export function cadeia(store: ArmazemContextos, c: Contexto): Contexto[] {
  const out = [c];
  for (let p = c.parentId; p; ) {
    const pai = store.obter(p);
    if (!pai) break;
    out.unshift(pai);
    p = pai.parentId;
  }
  return out;
}

function descendentes(todos: Contexto[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let mudou = true; mudou; ) {
    mudou = false;
    for (const c of todos) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) ids.add(c.id), (mudou = true);
  }
  return ids;
}

/** Rotas /contextos*. Devolve undefined quando a rota não é de Contextos. */
export function rotaContextos(
  store: ArmazemContextos,
  metodo: string,
  path: string,
  query: URLSearchParams,
  corpo: () => Promise<Record<string, unknown>>,
  tarefas: () => { id: string }[],
): Promise<Resposta> | Resposta | undefined {
  if (path === "/contextos" && metodo === "GET") return ok(store.listar());
  if (path === "/contextos" && metodo === "POST") {
    return corpo().then((e) => {
      const c = novoContexto(e);
      if (c.parentId && !store.obter(c.parentId)) throw new ErroValidacao("Contexto pai não existe");
      store.inserir(c);
      return ok(c, 201);
    });
  }
  if (path === "/contextos/arvore" && metodo === "GET") {
    const todos = store.listar();
    type No = Contexto & { children: No[] };
    const nos = new Map<string, No>(todos.map((c) => [c.id, { ...c, children: [] }]));
    const raizes: No[] = [];
    for (const n of nos.values()) (n.parentId ? nos.get(n.parentId)?.children : raizes)?.push(n);
    return ok(raizes);
  }
  const m = path.match(/^\/contextos\/([^/]+)(?:\/(resolvido|tarefas))?$/);
  if (m) {
    const c = store.obter(m[1]);
    if (!c) return naoEncontrado;
    if (!m[2] && metodo === "GET") return ok(c);
    if (!m[2] && metodo === "PATCH")
      return corpo().then((e) => {
        const novo = editarContexto(c, e);
        store.atualizar(novo);
        return ok(novo);
      });
    if (m[2] === "resolvido" && metodo === "GET") return ok(resolverContexto(cadeia(store, c)));
    if (m[2] === "tarefas" && metodo === "GET") {
      const ids = query.has("subarvore") ? descendentes(store.listar(), c.id) : new Set([c.id]);
      const mapa = store.mapaTarefaContexto();
      return ok(tarefas().filter((t) => ids.has(mapa.get(t.id) ?? "")));
    }
  }
  return undefined;
}
