import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ApiProvider } from "@/lib/api-provider";
import { criarRouter } from "@/lib/router";
import { ThemeProvider } from "@/lib/theme";

/** `initialPath` (ex.: "/?contexto=abc") troca o histórico do navegador por um em memória, para testes. */
export function App({ refetchIntervalMs, initialPath }: { refetchIntervalMs?: number; initialPath?: string } = {}) {
  const [router] = useState(() => criarRouter(initialPath));
  return (
    <ThemeProvider>
      <ApiProvider refetchIntervalMs={refetchIntervalMs}>
        <RouterProvider router={router} />
      </ApiProvider>
    </ThemeProvider>
  );
}
