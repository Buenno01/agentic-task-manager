import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDashedIcon,
  ClipboardCheckIcon,
  CompassIcon,
  FlameIcon,
  HandIcon,
  ListOrderedIcon,
  MinusIcon,
  PlayIcon,
  SearchCheckIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import type { Nivel, Tarefa } from "@/lib/api";

/** Estados na ordem de atenção do humano: o que exige ação primeiro. Estado em si é do daemon; aqui só ordem e aparência. */
export const ESTADOS = [
  "Aguardando humano",
  "Plano pronto para aprovação",
  "Em validação",
  "Novo",
  "Autorizada para explorar",
  "Explorando",
  "Aprovado",
  "Na fila",
  "Em execução",
  "Concluído",
  "Rejeitado",
] as const;

export const ESTADO_AGUARDANDO = "Aguardando humano";

interface Aparencia {
  icone: LucideIcon;
  cor: string;
}

const ESTADO_APARENCIA: Record<string, Aparencia> = {
  "Aguardando humano": { icone: HandIcon, cor: "text-amber-500" },
  "Plano pronto para aprovação": { icone: ClipboardCheckIcon, cor: "text-violet-500" },
  "Em validação": { icone: SearchCheckIcon, cor: "text-cyan-500" },
  Novo: { icone: SparklesIcon, cor: "text-sky-500" },
  "Autorizada para explorar": { icone: CompassIcon, cor: "text-teal-500" },
  Explorando: { icone: SearchCheckIcon, cor: "text-blue-500" },
  Aprovado: { icone: CheckIcon, cor: "text-emerald-500" },
  "Na fila": { icone: ListOrderedIcon, cor: "text-slate-400" },
  "Em execução": { icone: PlayIcon, cor: "text-indigo-500" },
  Concluído: { icone: CheckCircle2Icon, cor: "text-green-500" },
  Rejeitado: { icone: BanIcon, cor: "text-red-500" },
};
const ESTADO_DESCONHECIDO: Aparencia = { icone: CircleDashedIcon, cor: "text-muted-foreground" };

export const aparenciaEstado = (estado: string): Aparencia => ESTADO_APARENCIA[estado] ?? ESTADO_DESCONHECIDO;

const PRIORIDADE_APARENCIA: Record<Nivel, Aparencia> = {
  baixa: { icone: ArrowDownIcon, cor: "text-slate-400" },
  média: { icone: MinusIcon, cor: "text-sky-500" },
  alta: { icone: ArrowUpIcon, cor: "text-orange-500" },
  urgente: { icone: FlameIcon, cor: "text-red-500" },
};
export const aparenciaPrioridade = (nivel: Nivel): Aparencia => PRIORIDADE_APARENCIA[nivel];

/** Sem Prioridade na resposta, o daemon usa média por padrão. */
export const nivelDe = (t: Tarefa): Nivel => t.priority?.nivel ?? "média";

export interface Grupo {
  estado: string;
  tarefas: Tarefa[];
}

/** Agrupa por estado na ordem de ESTADOS (desconhecidos ao fim), mantendo a ordem de chegada dentro do grupo. */
export function agrupar(tarefas: Tarefa[]): Grupo[] {
  const mapa = new Map<string, Tarefa[]>();
  for (const t of tarefas) mapa.set(t.state, [...(mapa.get(t.state) ?? []), t]);
  const peso = (e: string) => {
    const i = (ESTADOS as readonly string[]).indexOf(e);
    return i === -1 ? ESTADOS.length : i;
  };
  return [...mapa.entries()].sort(([a], [b]) => peso(a) - peso(b)).map(([estado, ts]) => ({ estado, tarefas: ts }));
}

export const contarAguardando = (tarefas: Tarefa[]) => tarefas.filter((t) => t.state === ESTADO_AGUARDANDO).length;
