import type { Tarefa } from "./tarefa.ts";

/** Uma dependência está pendente enquanto a Tarefa de que se depende não foi Aprovada. */
export const dependenciaPendente = (estado: Tarefa["state"]) => estado !== "Aprovado";

/** Estados em que B está em andamento e, portanto, é afetada se A for rejeitada ou reabrida. */
export const ESTADOS_ATIVOS: Tarefa["state"][] = ["Autorizada para explorar", "Explorando", "Plano pronto para aprovação"];

/** Declarar "b depende de a" criaria ciclo (inclui b === a) se `a` já alcança `b` pelas dependências. */
export function criaCiclo(b: string, a: string, dependeDe: (id: string) => string[]): boolean {
  const visto = new Set<string>();
  const pilha = [a];
  while (pilha.length) {
    const x = pilha.pop()!;
    if (x === b) return true;
    if (visto.has(x)) continue;
    visto.add(x);
    pilha.push(...dependeDe(x));
  }
  return false;
}
