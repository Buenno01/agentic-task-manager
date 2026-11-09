import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adicionarDependencia, ajustarSubtarefa, removerDependencia } from "@/lib/api-subtarefas";

/** Mutações de Subtarefa/Dependência; renovam listas e detalhes (chaves sob ["tarefas"]). */
export function useAjustarSubtarefa(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: { title: string; description: string }) => ajustarSubtarefa(id, c),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });
}

export function useAdicionarDependencia(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dependeDe: string) => adicionarDependencia(id, dependeDe),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });
}

export function useRemoverDependencia(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dependeDe: string) => removerDependencia(id, dependeDe),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });
}
