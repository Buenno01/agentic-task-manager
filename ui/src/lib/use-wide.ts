import { useSyncExternalStore } from "react";

/** Breakpoint a partir do qual a sidebar fica fixa (abaixo vira drawer). Igual ao `lg` do Tailwind. */
export const LARGE_QUERY = "(min-width: 1024px)";

/** Só mede a largura; sem matchMedia (ex.: jsdom) assume tela larga. */
export function useTelaLarga(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia?.(LARGE_QUERY);
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    () => window.matchMedia?.(LARGE_QUERY).matches ?? true,
  );
}
