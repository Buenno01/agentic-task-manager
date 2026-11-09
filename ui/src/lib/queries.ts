import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  criarContexto,
  listarArvore,
  listarTarefas,
  listarTarefasDoContexto,
  obterConsolidado,
  obterResolvido,
} from "@/lib/api";
import { useSessao } from "@/lib/api-provider";

/** Hooks de dados: ficam desligados sem token (o diálogo cuida disso). Polling vem dos defaults do QueryClient. */

/** Tarefas; com `contextoId`, as do Contexto e de toda a subárvore. */
export function useTarefas(contextoId?: string) {
  const { temToken } = useSessao();
  return useQuery({
    queryKey: ["tarefas", contextoId ?? null],
    queryFn: () => (contextoId ? listarTarefasDoContexto(contextoId) : listarTarefas()),
    enabled: temToken,
  });
}

export function useArvoreContextos() {
  const { temToken } = useSessao();
  return useQuery({ queryKey: ["contextos", "arvore"], queryFn: listarArvore, enabled: temToken });
}

export function useContextoResolvido(id: string) {
  const { temToken } = useSessao();
  return useQuery({ queryKey: ["contextos", id, "resolvido"], queryFn: () => obterResolvido(id), enabled: temToken });
}

export function useConsolidado(id: string) {
  const { temToken } = useSessao();
  return useQuery({ queryKey: ["contextos", id, "consolidado"], queryFn: () => obterConsolidado(id), enabled: temToken });
}

export function useCriarContexto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: criarContexto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contextos"] }),
  });
}
