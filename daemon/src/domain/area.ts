import { ErroValidacao } from "./tarefa.ts";

/** Normaliza um item da Área prevista: sem espaços, "./" inicial nem "/" nas pontas. */
export function normalizarCaminho(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/** Valida e normaliza a lista (sem duplicatas, ordem preservada). */
export function validarArea(entrada: unknown): string[] {
  if (!Array.isArray(entrada)) throw new ErroValidacao("paths deve ser uma lista de textos");
  const out: string[] = [];
  for (const p of entrada) {
    const n = typeof p === "string" ? normalizarCaminho(p) : "";
    if (!n) throw new ErroValidacao("Cada item da Área prevista deve ser um caminho não vazio");
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const temCuringa = (s: string) => /[*?]/.test(s);
const prefixoLiteral = (s: string) => s.split(/[*?]/, 1)[0];

function regexSegmento(s: string): RegExp {
  const re = s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

function segmentosCompativeis(a: string, b: string): boolean {
  if (a === "**" || b === "**") return true;
  const ga = temCuringa(a);
  const gb = temCuringa(b);
  if (!ga && !gb) return a === b;
  if (ga && !gb) return regexSegmento(a).test(b);
  if (!ga && gb) return regexSegmento(b).test(a);
  // dois curingas: compatíveis se os prefixos literais não se contradizem (aproximação conservadora)
  const pa = prefixoLiteral(a);
  const pb = prefixoLiteral(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/**
 * Dois itens da Área prevista se sobrepõem quando um é prefixo de diretório do outro
 * (por segmento) ou quando padrões glob (`*`, `?`, `**`) podem alcançar o mesmo caminho.
 */
export function areasSobrepoem(x: string, y: string): boolean {
  const a = normalizarCaminho(x).split("/").filter(Boolean);
  const b = normalizarCaminho(y).split("/").filter(Boolean);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === "**" || b[i] === "**") return true;
    if (!segmentosCompativeis(a[i], b[i])) return false;
  }
  return true; // um é ancestral do outro (ou iguais)
}

export interface AvisoSobreposicao {
  taskId: string;
  title: string;
  state: string;
  overlaps: { mine: string; theirs: string }[];
}

export interface TarefaParaSobreposicao {
  id: string;
  title: string;
  state: string;
  repository: string | null;
  area: string[];
}

const FECHADOS = ["Rejeitado", "Concluído"];

/** Tarefas abertas = todas, menos Rejeitada/Concluída (Aprovada continua aberta: vai executar). */
export function calcularAvisos(alvo: TarefaParaSobreposicao, todas: TarefaParaSobreposicao[]): AvisoSobreposicao[] {
  if (!alvo.repository || alvo.area.length === 0) return [];
  const avisos: AvisoSobreposicao[] = [];
  for (const o of todas) {
    if (o.id === alvo.id || o.repository !== alvo.repository || FECHADOS.includes(o.state)) continue;
    const overlaps = alvo.area.flatMap((mine) => o.area.filter((theirs) => areasSobrepoem(mine, theirs)).map((theirs) => ({ mine, theirs })));
    if (overlaps.length) avisos.push({ taskId: o.id, title: o.title, state: o.state, overlaps });
  }
  return avisos;
}
