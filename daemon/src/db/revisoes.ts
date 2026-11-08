import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { MudancaMetrica } from "../domain/revisao.ts";

export interface Revisao {
  id: string;
  coletorId: string;
  coletaId: string;
  period: string;
  previousSnapshotId: string;
  snapshotId: string;
  changes: MudancaMetrica[];
  createdAt: string;
}

export interface Lacuna {
  id: string;
  coletorId: string;
  coletaId: string;
  period: string;
  error: string;
  createdAt: string;
  recoveredAt: string | null;
  recoveredByColetaId: string | null;
  /** Lacuna parcial: o período tem Snapshot, mas faltam métricas (`missing`). */
  partial: boolean;
  /** Categoria da causa de uma Lacuna parcial (`analytics-indisponivel` = plano/escopo sem analytics, exige ação humana); `null` na Lacuna total. */
  cause: string | null;
  /** Métricas ausentes do período (vazio na Lacuna total). */
  missing: string[];
}

/** Dados de uma Lacuna parcial. */
export interface ParcialDaLacuna {
  causa: string;
  faltando: string[];
}

const linhaRevisao = (r: Record<string, unknown>): Revisao => ({
  id: r.id as string,
  coletorId: r.coletor_id as string,
  coletaId: r.coleta_id as string,
  period: r.period as string,
  previousSnapshotId: r.previous_snapshot_id as string,
  snapshotId: r.snapshot_id as string,
  changes: JSON.parse(r.changes as string),
  createdAt: r.created_at as string,
});

const linhaLacuna = (r: Record<string, unknown>): Lacuna => ({
  id: r.id as string,
  coletorId: r.coletor_id as string,
  coletaId: r.coleta_id as string,
  period: r.period as string,
  error: r.error as string,
  createdAt: r.created_at as string,
  recoveredAt: (r.recovered_at as string | null) ?? null,
  recoveredByColetaId: (r.recovered_by_coleta_id as string | null) ?? null,
  partial: r.partial === 1,
  cause: (r.cause as string | null) ?? null,
  missing: JSON.parse((r.missing as string | null) ?? "[]"),
});

/** Revisões (sem expurgo) e Lacunas de Coletas. O texto do erro da Lacuna é mascarado (ADR-0007). */
export function abrirRevisoes(path: string, mascarar: (s: string) => string = (s) => s) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS revisoes (
      id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      coleta_id TEXT NOT NULL,
      period TEXT NOT NULL,
      previous_snapshot_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lacunas (
      id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      coleta_id TEXT NOT NULL,
      period TEXT NOT NULL,
      error TEXT NOT NULL,
      created_at TEXT NOT NULL,
      recovered_at TEXT,
      recovered_by_coleta_id TEXT,
      seq INTEGER NOT NULL
    );
  `);
  // Lacuna parcial (ticket 05): colunas acrescentadas a bancos criados antes.
  const colunas = (db.prepare("PRAGMA table_info(lacunas)").all() as { name: string }[]).map((c) => c.name);
  if (!colunas.includes("partial")) db.exec("ALTER TABLE lacunas ADD COLUMN partial INTEGER NOT NULL DEFAULT 0");
  if (!colunas.includes("cause")) db.exec("ALTER TABLE lacunas ADD COLUMN cause TEXT");
  if (!colunas.includes("missing")) db.exec("ALTER TABLE lacunas ADD COLUMN missing TEXT NOT NULL DEFAULT '[]'");
  const proximo = (tabela: string) => (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ${tabela}`).get() as { n: number }).n;
  const insRevisao = db.prepare(
    "INSERT INTO revisoes (id, coletor_id, coleta_id, period, previous_snapshot_id, snapshot_id, changes, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const revisoesDoColetor = db.prepare("SELECT * FROM revisoes WHERE coletor_id = ? ORDER BY seq");
  const lacunaAberta = db.prepare("SELECT id, partial FROM lacunas WHERE coletor_id = ? AND period = ? AND recovered_at IS NULL");
  const insLacuna = db.prepare("INSERT INTO lacunas (id, coletor_id, coleta_id, period, error, created_at, seq, partial, cause, missing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const lacunasDoColetor = db.prepare("SELECT * FROM lacunas WHERE coletor_id = ? ORDER BY seq");
  const abertas = db.prepare("SELECT period FROM lacunas WHERE coletor_id = ? AND recovered_at IS NULL ORDER BY period");
  const recupera = db.prepare("UPDATE lacunas SET recovered_at = ?, recovered_by_coleta_id = ? WHERE coletor_id = ? AND period = ? AND recovered_at IS NULL");

  return {
    registrarRevisao(r: Omit<Revisao, "id" | "createdAt">, agora: Date): Revisao {
      const id = randomUUID();
      insRevisao.run(id, r.coletorId, r.coletaId, r.period, r.previousSnapshotId, r.snapshotId, JSON.stringify(r.changes), agora.toISOString(), proximo("revisoes"));
      return { ...r, id, createdAt: agora.toISOString() };
    },
    listarRevisoes: (coletorId: string) => (revisoesDoColetor.all(coletorId) as Record<string, unknown>[]).map(linhaRevisao),
    /**
     * Abre a Lacuna do período; se já há uma aberta, não duplica. Exceção: uma Lacuna total aberta
     * cede lugar à parcial quando o período passa a ter Snapshot (a total é dada como recuperada).
     */
    abrirLacuna(coletorId: string, coletaId: string, period: string, erro: string, agora: Date, parcial?: ParcialDaLacuna) {
      const aberta = lacunaAberta.get(coletorId, period) as { id: string; partial: number } | undefined;
      if (aberta && (aberta.partial === 1 || !parcial)) return;
      if (aberta) recupera.run(agora.toISOString(), coletaId, coletorId, period);
      insLacuna.run(randomUUID(), coletorId, coletaId, period, mascarar(erro), agora.toISOString(), proximo("lacunas"), parcial ? 1 : 0, parcial?.causa ?? null, JSON.stringify(parcial?.faltando ?? []));
    },
    listarLacunas: (coletorId: string) => (lacunasDoColetor.all(coletorId) as Record<string, unknown>[]).map(linhaLacuna),
    /** Períodos com Lacuna aberta, em ordem. */
    periodosEmAberto: (coletorId: string) => (abertas.all(coletorId) as { period: string }[]).map((r) => r.period),
    recuperarLacuna: (coletorId: string, period: string, coletaId: string, agora: Date) =>
      void recupera.run(agora.toISOString(), coletaId, coletorId, period),
    close: () => db.close(),
  };
}
export type ArmazemRevisoes = ReturnType<typeof abrirRevisoes>;
