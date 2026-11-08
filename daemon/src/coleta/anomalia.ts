import type { Snapshot } from "../db/coletas.ts";
import type { EntradaAnomalia } from "../db/anomalias.ts";
import { dataNoFuso, somarDias } from "../domain/agenda.ts";
import type { Limiares, Metrica } from "../domain/coleta.ts";

/** Só estas métricas geram Anomalia; a quebra por produto nunca (spec). */
export const METRICAS_ANOMALIA: readonly Metrica[] = ["orders", "netRevenue", "averageTicket", "conversion"];
export const OCORRENCIAS_BASE = 4;
export const PEDIDOS_MINIMOS_NA_BASE = 10;

/**
 * Avalia os dias fechados com Snapshot contra a média das últimas 4 ocorrências do mesmo dia da semana.
 * Pura: recebe os Snapshots mais recentes por período e o relógio; devolve as Anomalias detectadas.
 * Não avalia o dia corrente, métrica ausente (null) nem base com menos de 10 pedidos médios.
 */
export function detectarAnomalias(
  coletorId: string,
  snapshots: Snapshot[],
  limiares: Limiares,
  agoraMs: number,
  timezone: string,
): EntradaAnomalia[] {
  const hoje = dataNoFuso(agoraMs, timezone).data;
  const porPeriodo = new Map(snapshots.map((s) => [s.period, s]));
  const out: EntradaAnomalia[] = [];
  for (const s of snapshots) {
    if (s.period >= hoje) continue;
    const anteriores = Array.from({ length: OCORRENCIAS_BASE }, (_, i) => porPeriodo.get(somarDias(s.period, -7 * (i + 1))));
    if (anteriores.some((a) => !a)) continue;
    const media = (m: Metrica): number | null => {
      const vs = anteriores.map((a) => a!.payload[m]);
      return vs.some((v) => v === null || v === undefined) ? null : (vs as number[]).reduce((x, y) => x + y, 0) / vs.length;
    };
    const baseDePedidos = media("orders");
    if (baseDePedidos === null || baseDePedidos < PEDIDOS_MINIMOS_NA_BASE) continue;
    for (const metric of METRICAS_ANOMALIA) {
      const value = s.payload[metric];
      const base = media(metric);
      if (value === null || value === undefined || base === null || base === 0) continue;
      const variation = ((value - base) / base) * 100;
      if (Math.abs(variation) > limiares[metric]) out.push({ coletorId, period: s.period, metric, value, base, variation, snapshotId: s.id });
    }
  }
  return out;
}
