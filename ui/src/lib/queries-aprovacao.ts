import { useMutation, useQueryClient } from "@tanstack/react-query";
import { executarAcao, type AcaoAprovacao } from "@/lib/api-aprovacao";

/** Ação de estado (aprovar, rejeitar, reabrir) numa Tarefa; renova listas, detalhe e histórico. */
export function useAcaoAprovacao(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { acao: AcaoAprovacao; motivo?: string }) => executarAcao(id, v.acao, v.motivo),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });
}
