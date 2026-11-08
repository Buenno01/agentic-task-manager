import { ErroValidacao } from "./tarefa.ts";
import { dataNoFuso, somarDias } from "./agenda.ts";

/** Fechamento de período do Monitoramento: gatilho de análise mesmo sem Anomalia (padrão semanal). */
export const FREQUENCIAS_FECHAMENTO = ["semanal", "mensal", "nenhum"] as const;
export type FrequenciaFechamento = (typeof FREQUENCIAS_FECHAMENTO)[number];
export const FECHAMENTO_PADRAO: FrequenciaFechamento = "semanal";

/** Hora do fechamento (07:00 no fuso da loja), em minutos desde 00:00. */
const MINUTO_FECHAMENTO = 7 * 60;

export interface Fechamento {
  frequencia: "semanal" | "mensal";
  /** Dia em que o fechamento ocorreu (segunda, ou dia 1); identifica-o de forma única por Coletor. */
  chave: string;
  /** Primeiro e último dia analisados (inclusive). */
  de: string;
  ate: string;
}

/** Lê `closingFrequency` dos params do Coletor (opcional); lança ErroValidacao se inválido. */
export function frequenciaDeFechamento(params: Record<string, unknown>): FrequenciaFechamento {
  const f = params.closingFrequency ?? FECHAMENTO_PADRAO;
  if (!FREQUENCIAS_FECHAMENTO.includes(f as FrequenciaFechamento)) throw new ErroValidacao(`closingFrequency deve ser: ${FREQUENCIAS_FECHAMENTO.join(", ")}`);
  return f as FrequenciaFechamento;
}

const diaDaSemana = (data: string) => new Date(`${data}T00:00:00Z`).getUTCDay();
const primeiroDoMes = (data: string) => `${data.slice(0, 8)}01`;
const mesAnterior = (data: string) => primeiroDoMes(somarDias(primeiroDoMes(data), -1));

function descrever(frequencia: "semanal" | "mensal", chave: string): Fechamento {
  if (frequencia === "semanal") return { frequencia, chave, de: somarDias(chave, -7), ate: somarDias(chave, -1) };
  return { frequencia, chave, de: mesAnterior(chave), ate: somarDias(chave, -1) };
}

/** Fechamento imediatamente anterior a `chave` (segunda anterior ou dia 1 do mês anterior). */
function anterior(frequencia: "semanal" | "mensal", chave: string): string {
  return frequencia === "semanal" ? somarDias(chave, -7) : mesAnterior(chave);
}

/** Último fechamento já ocorrido em `ms` (segunda 07:00 ou dia 1 às 07:00, no fuso da loja). */
export function ultimoFechamento(ms: number, timezone: string, frequencia: "semanal" | "mensal"): Fechamento {
  const { data, minutos } = dataNoFuso(ms, timezone);
  let chave = frequencia === "semanal" ? somarDias(data, -((diaDaSemana(data) + 6) % 7)) : primeiroDoMes(data);
  if (chave === data && minutos < MINUTO_FECHAMENTO) chave = anterior(frequencia, chave);
  return descrever(frequencia, chave);
}

/**
 * Fechamentos a processar: todos os posteriores a `ultimaChave` até o último ocorrido, em ordem
 * (recuperação do boot, sem teto: nenhum período perdido é descartado em silêncio).
 */
export function fechamentosPendentes(ms: number, timezone: string, frequencia: "semanal" | "mensal", ultimaChave: string): Fechamento[] {
  const fila: Fechamento[] = [];
  for (let chave = ultimoFechamento(ms, timezone, frequencia).chave; chave > ultimaChave; chave = anterior(frequencia, chave)) fila.unshift(descrever(frequencia, chave));
  return fila;
}
