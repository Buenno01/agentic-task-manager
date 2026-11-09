import { useQuery } from "@tanstack/react-query";
import { listarTarefas } from "@/lib/api";
import { useSessao } from "@/lib/api-provider";

/** Hooks de dados: ficam desligados sem token (o diálogo cuida disso). Polling vem dos defaults do QueryClient. */
export function useTarefas() {
  const { temToken } = useSessao();
  return useQuery({ queryKey: ["tarefas"], queryFn: listarTarefas, enabled: temToken });
}
