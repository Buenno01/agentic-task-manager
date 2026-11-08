/** Mudança de uma métrica entre dois Snapshots do mesmo período. Ausente conta como `null`. */
export interface MudancaMetrica {
  metric: string;
  previous: number | null;
  new: number | null;
}

/** Métricas cujo valor difere entre o Snapshot anterior e o novo, em ordem estável. */
export function diferencas(anterior: Record<string, number | null>, novo: Record<string, number | null>): MudancaMetrica[] {
  const nomes = [...new Set([...Object.keys(anterior), ...Object.keys(novo)])].sort();
  return nomes
    .map((metric) => ({ metric, previous: anterior[metric] ?? null, new: novo[metric] ?? null }))
    .filter((m) => m.previous !== m.new);
}

/** Os `dias` períodos (AAAA-MM-DD) que terminam em `fim`, em ordem crescente. */
export function janelaDeRecoleta(fim: string, dias: number): string[] {
  const base = Date.parse(`${fim}T00:00:00Z`);
  return Array.from({ length: dias }, (_, i) => new Date(base - (dias - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}
