import { ErroValidacao } from "./tarefa.ts";

/** Padrões da Coleta diária (spec do Monitoramento): 06:00 no fuso da loja; backfill de 90 dias. */
export const HORARIO_PADRAO = "06:00";
export const FUSO_PADRAO = "America/Sao_Paulo";
export const BACKFILL_DIAS = 90;

const HORARIO = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface Agenda {
  /** HH:MM no fuso da loja. */
  scheduleTime: string;
  /** Fuso IANA da loja. */
  timezone: string;
}

const fusoValido = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Lê `scheduleTime` e `timezone` dos params do Coletor (opcionais); lança ErroValidacao se inválidos. */
export function agendaDoColetor(params: Record<string, unknown>): Agenda {
  const h = params.scheduleTime ?? HORARIO_PADRAO;
  const tz = params.timezone ?? FUSO_PADRAO;
  if (typeof h !== "string" || !HORARIO.test(h)) throw new ErroValidacao("scheduleTime deve ser HH:MM (00:00 a 23:59)");
  if (typeof tz !== "string" || !fusoValido(tz)) throw new ErroValidacao("timezone deve ser um fuso IANA válido (ex.: America/Sao_Paulo)");
  return { scheduleTime: h, timezone: tz };
}

/** Dia civil (AAAA-MM-DD) e minutos desde 00:00 de um instante, no fuso dado. */
export function dataNoFuso(ms: number, timezone: string): { data: string; minutos: number } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { data: `${partes.year}-${partes.month}-${partes.day}`, minutos: Number(partes.hour) * 60 + Number(partes.minute) };
}

export function somarDias(data: string, dias: number): string {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

/** Último período (dia civil da loja) que já deveria ter sido coletado: ontem, se a hora da Coleta de hoje passou; senão anteontem. */
export function ultimoPeriodoDevido(ms: number, agenda: Agenda): string {
  const { data, minutos } = dataNoFuso(ms, agenda.timezone);
  const [h, m] = agenda.scheduleTime.split(":").map(Number);
  return somarDias(data, minutos >= h * 60 + m ? -1 : -2);
}
