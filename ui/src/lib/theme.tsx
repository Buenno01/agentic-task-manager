import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Tema = "escuro" | "claro";
const CHAVE = "atm-tema";

function lerTema(): Tema {
  return localStorage.getItem(CHAVE) === "claro" ? "claro" : "escuro"; // dark-first
}

const Ctx = createContext<{ tema: Tema; alternar: () => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [tema, setTema] = useState<Tema>(lerTema);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", tema === "escuro");
  }, [tema]);

  const alternar = () =>
    setTema((atual) => {
      const novo = atual === "escuro" ? "claro" : "escuro";
      localStorage.setItem(CHAVE, novo);
      return novo;
    });

  return <Ctx.Provider value={{ tema, alternar }}>{children}</Ctx.Provider>;
}

export function useTema() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTema fora do ThemeProvider");
  return ctx;
}
