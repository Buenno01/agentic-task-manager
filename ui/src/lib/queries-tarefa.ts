import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSessao } from "@/lib/api-provider";
import { comentar, listarEventos, obterTarefa, type TipoComentario } from "@/lib/api-tarefa";

/**
 * Hooks do detalhe da Tarefa. Chaves sob ["tarefas", "detalhe", id, ...] para que
 * `invalidateQueries({ queryKey: ["tarefas"] })` (qualquer mutação de Tarefa) também renove o detalhe.
 * Polling de 5 s vem dos defaults do QueryClient.
 */
export const chaveDetalhe = (id: string) => ["tarefas", "detalhe", id] as const;

export function useTarefa(id: string) {
  const { temToken } = useSessao();
  return useQuery({ queryKey: [...chaveDetalhe(id), "tarefa"], queryFn: () => obterTarefa(id), enabled: temToken });
}

export function useHistorico(id: string) {
  const { temToken } = useSessao();
  return useQuery({ queryKey: [...chaveDetalhe(id), "eventos"], queryFn: () => listarEventos(id), enabled: temToken });
}

export function useComentar(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: { tipo: TipoComentario; texto: string; respondeA?: string }) => comentar(id, c),
    onSuccess: () => qc.invalidateQueries({ queryKey: chaveDetalhe(id) }),
  });
}
