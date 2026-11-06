import type { Tarefa } from "./tarefa.ts";

/** Uma dependência está satisfeita quando A foi Aprovada ou já seguiu para a Execução (Na fila…Concluído). */
const ESTADOS_SATISFEITOS: Tarefa["state"][] = ["Aprovado", "Na fila", "Em execução", "Em validação", "Concluído"];
export const dependenciaPendente = (estado: Tarefa["state"]) => !ESTADOS_SATISFEITOS.includes(estado);

/** Estados em que B está em andamento (Exploração ou Execução) e, portanto, é afetada se A for rejeitada ou reabrida. */
export const ESTADOS_ATIVOS: Tarefa["state"][] = [
  "Autorizada para explorar", "Explorando", "Plano pronto para aprovação",
  "Na fila", "Em execução", "Em validação",
];

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
