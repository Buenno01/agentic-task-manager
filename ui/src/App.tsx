import { ThemeToggle } from "@/components/theme-toggle";
import { ThemeProvider } from "@/lib/theme";

export function App() {
  return (
    <ThemeProvider>
      <header className="flex h-14 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold">Agentic Task Manager</h1>
        <ThemeToggle />
      </header>
      <main className="p-6 text-sm text-muted-foreground">Nada por aqui ainda.</main>
    </ThemeProvider>
  );
}
