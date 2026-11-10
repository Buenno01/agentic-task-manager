import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { AtualizacaoProvider, ResultadoAtualizacao, VersaoEAtualizar } from "@/components/atualizacao";
import { CommandPalette } from "@/components/command-palette";
import { ConnectionBanner } from "@/components/connection-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { TokenDialog } from "@/components/token-dialog";
import { Workspace } from "@/components/workspace";
import { NIVEIS, type Nivel } from "@/lib/api";

/**
 * Roteamento por código (sem plugin de arquivos). Rota única "/" com `?contexto=<id>`.
 * Novas telas: crie a rota com `createRoute({ getParentRoute: () => rootRoute, ... })`,
 * adicione a `routeTree` e declare seus search params em `validateSearch`.
 */
export interface SearchRaiz {
  contexto?: string;
  /** Filtro por estado (nome do estado). */
  estado?: string;
  prioridade?: Nivel;
  /** Só `false` vai para a URL; ausente = incluir sub-Contextos. */
  subcontextos?: false;
  /** Tarefa aberta no painel de detalhe. */
  tarefa?: string;
}

const texto = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function Shell() {
  return (
    <AtualizacaoProvider>
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold">Agentic Task Manager</h1>
        <div className="flex items-center gap-2">
          <VersaoEAtualizar />
          <ThemeToggle />
        </div>
      </header>
      <ConnectionBanner />
      <ResultadoAtualizacao />
      <Outlet />
      <TokenDialog />
      <CommandPalette />
    </div>
    </AtualizacaoProvider>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): SearchRaiz => ({
    contexto: texto(s.contexto),
    estado: texto(s.estado),
    prioridade: NIVEIS.find((n) => n === s.prioridade),
    subcontextos: s.subcontextos === false || s.subcontextos === "false" ? false : undefined,
    tarefa: texto(s.tarefa),
  }),
  component: Workspace,
});
/** Link direto `/tarefas/:id`: abre o mesmo detalhe (painel de "/?tarefa=:id"), preservando os filtros. */
export const tarefaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tarefas/$id",
  validateSearch: indexRoute.options.validateSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/", search: { ...search, tarefa: params.id }, replace: true });
  },
});
export const routeTree = rootRoute.addChildren([indexRoute, tarefaRoute]);

/** `initialPath` usa histórico em memória (testes); sem ele, histórico do navegador. */
export function criarRouter(initialPath?: string) {
  return createRouter({
    routeTree,
    history: initialPath ? createMemoryHistory({ initialEntries: [initialPath] }) : undefined,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof criarRouter>;
  }
}
