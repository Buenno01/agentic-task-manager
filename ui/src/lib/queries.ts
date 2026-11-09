import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buscar,
  criarContexto,
  criarTarefa,
  definirPrioridade,
  type Nivel,
  listarArvore,
  listarTarefas,
  listarTarefasDoContexto,
  obterConsolidado,
  obterResolvido,
} from "@/lib/api";
import { useSessao } from "@/lib/api-provider";

/** Hooks de dados: ficam desligados sem token (o diálogo cuida disso). Polling vem dos defaults do QueryClient. */

/** Tarefas; com `contextoId`, as do Contexto e de toda a subárvore. */
export function useTarefas(contextoId?: string, subarvore = true) {
  const { temToken } = useSessao();
  return useQuery({
    queryKey: ["tarefas", contextoId ?? null, contextoId ? subarvore : true],
    queryFn: () => (contextoId ? listarTarefasDoContexto(contextoId, subarvore) : listarTarefas()),
    enabled: temToken,
  });
}

export function useCriarTarefa() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: criarTarefa, onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }) });
}

export function useDefinirPrioridade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, nivel }: { id: string; nivel: Nivel }) => definirPrioridade(id, nivel),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tarefas"] }),
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

/** Busca no daemon; só dispara com consulta não vazia. */
export function useBusca(q: string, contexto?: string, subarvore = true) {
  const { temToken } = useSessao();
  return useQuery({
    queryKey: ["busca", q, contexto ?? null, subarvore],
    queryFn: () => buscar(q, contexto, subarvore),
    enabled: temToken && q.length > 0,
    refetchInterval: false,
  });
}

export function useCriarContexto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: criarContexto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contextos"] }),
  });
}
