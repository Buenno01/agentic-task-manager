import { ConnectionBanner } from "@/components/connection-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { TokenDialog } from "@/components/token-dialog";
import { ApiProvider } from "@/lib/api-provider";
import { useTarefas } from "@/lib/queries";
import { ThemeProvider } from "@/lib/theme";

function Conteudo() {
  const { data } = useTarefas();
  return (
    <main className="p-6 text-sm text-muted-foreground">
      {data?.length ? (
        <ul>
          {data.map((t) => (
            <li key={t.id}>{t.title}</li>
          ))}
        </ul>
      ) : (
        "Nada por aqui ainda."
      )}
    </main>
  );
}

export function App({ refetchIntervalMs }: { refetchIntervalMs?: number } = {}) {
  return (
    <ThemeProvider>
      <ApiProvider refetchIntervalMs={refetchIntervalMs}>
        <header className="flex h-14 items-center justify-between border-b px-6">
          <h1 className="text-sm font-semibold">Agentic Task Manager</h1>
          <ThemeToggle />
        </header>
        <ConnectionBanner />
        <Conteudo />
        <TokenDialog />
      </ApiProvider>
    </ThemeProvider>
  );
}
