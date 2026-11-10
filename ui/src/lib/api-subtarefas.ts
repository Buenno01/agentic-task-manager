import { api, type Tarefa } from "@/lib/api";

// Subtarefas e Dependências (daemon/src/api/subtarefas.ts, dependencias.ts). Só transporte:
// a API decide quem pode e o que é válido (ciclo, duplicata, 403/409 chegam como ApiError).

/** Resumo de Subtarefa que o daemon anexa à Tarefa-mãe. `decisao` é null enquanto não aprovada/rejeitada. */
export interface ResumoSubtarefa {
  id: string;
  title: string;
  state: string;
  decisao: "aprovada" | "rejeitada" | null;
}

/** Dependência ainda pendente (a Tarefa de que esta depende não foi concluída). */
export interface DependenciaPendente {
  id: string;
  title: string;
  state: string;
}

export const subtarefasDe = (t: Tarefa): ResumoSubtarefa[] => (t.subtarefas as ResumoSubtarefa[] | undefined) ?? [];
export const dependeDe = (t: Tarefa): string[] => (t.dependeDe as string[] | undefined) ?? [];
export const pendentesDe = (t: Tarefa): DependenciaPendente[] => (t.dependenciasPendentes as DependenciaPendente[] | undefined) ?? [];
export const maeDe = (t: Tarefa): string | null => (t.maeId as string | null | undefined) ?? null;

export const ajustarSubtarefa = (id: string, c: { title: string; description: string }) =>
  api<Tarefa>(`/tarefas/${id}`, { method: "PATCH", body: c });
export const adicionarDependencia = (id: string, dependeDe: string) =>
  api<unknown>(`/tarefas/${id}/dependencias`, { method: "POST", body: { dependeDe } });
export const removerDependencia = (id: string, dependeDe: string) =>
  api<void>(`/tarefas/${id}/dependencias/${dependeDe}`, { method: "DELETE" });
