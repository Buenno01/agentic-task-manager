import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { ConnectionBanner } from "@/components/connection-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { TokenDialog } from "@/components/token-dialog";
import { Workspace } from "@/components/workspace";

/**
 * Roteamento por código (sem plugin de arquivos). Rota única "/" com `?contexto=<id>`.
 * Novas telas: crie a rota com `createRoute({ getParentRoute: () => rootRoute, ... })`,
 * adicione a `routeTree` e declare seus search params em `validateSearch`.
 */
export interface SearchRaiz {
  contexto?: string;
}

function Shell() {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold">Agentic Task Manager</h1>
        <ThemeToggle />
      </header>
      <ConnectionBanner />
      <Outlet />
      <TokenDialog />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });
export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): SearchRaiz => ({
    contexto: typeof s.contexto === "string" && s.contexto ? s.contexto : undefined,
  }),
  component: Workspace,
});
export const routeTree = rootRoute.addChildren([indexRoute]);

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
