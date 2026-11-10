import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { estadoAtualizacao, pedirAtualizacao } from "@/lib/api-atualizacao";

export const useEstadoAtualizacao = () => useQuery({ queryKey: ["atualizacao"], queryFn: estadoAtualizacao });

export function usePedirAtualizacao() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: pedirAtualizacao, onSuccess: () => qc.invalidateQueries({ queryKey: ["atualizacao"] }) });
}
