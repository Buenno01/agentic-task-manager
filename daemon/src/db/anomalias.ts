import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Metrica } from "../domain/coleta.ts";

export interface Anomalia {
  id: string;
  coletorId: string;
  /** Dia civil avaliado (AAAA-MM-DD, fuso da loja). */
  period: string;
  metric: Metrica;
  /** Valor do dia avaliado. */
  value: number;
  /** Média das últimas 4 ocorrências do mesmo dia da semana. */
  base: number;
  /** Variação percentual sobre a base (negativa = queda). */
  variation: number;
  /** Snapshot avaliado. */
  snapshotId: string;
  createdAt: string;
}

export type EntradaAnomalia = Omit<Anomalia, "id" | "createdAt">;

const linha = (r: Record<string, unknown>): Anomalia => ({
  id: r.id as string,
  coletorId: r.coletor_id as string,
  period: r.period as string,
  metric: r.metric as Metrica,
  value: r.value as number,
  base: r.base as number,
  variation: r.variation as number,
  snapshotId: r.snapshot_id as string,
  createdAt: r.created_at as string,
});

/** Anomalias (sem expurgo). Uma por (Coletor, período, métrica): reavaliar não duplica. */
export function abrirAnomalias(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS anomalias (
      id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      period TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      base REAL NOT NULL,
      variation REAL NOT NULL,
      snapshot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      UNIQUE (coletor_id, period, metric)
    );
  `);
  const proximo = () => (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM anomalias").get() as { n: number }).n;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO anomalias (id, coletor_id, period, metric, value, base, variation, snapshot_id, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const doColetor = db.prepare("SELECT * FROM anomalias WHERE coletor_id = ? ORDER BY seq");
  return {
    /** Grava a Anomalia; devolve-a se é nova, `undefined` se já existia. */
    registrar(e: EntradaAnomalia, agora: Date): Anomalia | undefined {
      const id = randomUUID();
      const r = ins.run(id, e.coletorId, e.period, e.metric, e.value, e.base, e.variation, e.snapshotId, agora.toISOString(), proximo());
      return r.changes === 0 ? undefined : { ...e, id, createdAt: agora.toISOString() };
    },
    listar: (coletorId: string) => (doColetor.all(coletorId) as Record<string, unknown>[]).map(linha),
    close: () => db.close(),
  };
}
export type ArmazemAnomalias = ReturnType<typeof abrirAnomalias>;
