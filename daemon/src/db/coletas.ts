import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Coletor, EntradaColetor } from "../domain/coleta.ts";

export type EstadoColeta = "em andamento" | "concluída" | "falhou";

export interface Coleta {
  id: string;
  coletorId: string;
  period: string;
  state: EstadoColeta;
  error: string | null;
  /** Ids dos Snapshots gerados. */
  snapshots: string[];
  createdAt: string;
  finishedAt: string | null;
}

export interface Snapshot {
  id: string;
  coletorId: string;
  coletaId: string;
  period: string;
  currency: string;
  payload: Record<string, number | null>;
  hash: string;
  createdAt: string;
}

const COLETOR = "id, context_id, source, frequency, params, recollect_window_days, automatic_analysis, thresholds, token_env, created_at";
const linhaColetor = (r: Record<string, unknown>): Coletor => ({
  id: r.id as string,
  contextId: r.context_id as string,
  source: r.source as Coletor["source"],
  frequency: r.frequency as Coletor["frequency"],
  params: JSON.parse(r.params as string),
  recollectWindowDays: r.recollect_window_days as number,
  automaticAnalysis: r.automatic_analysis === 1,
  thresholds: JSON.parse(r.thresholds as string),
  tokenEnv: r.token_env as string,
  createdAt: r.created_at as string,
});

const linhaSnapshot = (r: Record<string, unknown>): Snapshot => ({
  id: r.id as string,
  coletorId: r.coletor_id as string,
  coletaId: r.coleta_id as string,
  period: r.period as string,
  currency: r.currency as string,
  payload: JSON.parse(r.payload as string),
  hash: r.hash as string,
  createdAt: r.created_at as string,
});

/**
 * Armazém de Coletores, Coletas e Snapshots. O banco só guarda o NOME da variável do token.
 * Snapshots são imutáveis: triggers recusam UPDATE e DELETE (a correção é um novo Snapshot).
 */
export function abrirColetas(path: string, mascarar: (s: string) => string = (s) => s) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS coletores (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      source TEXT NOT NULL,
      frequency TEXT NOT NULL,
      params TEXT NOT NULL,
      recollect_window_days INTEGER NOT NULL,
      automatic_analysis INTEGER NOT NULL,
      thresholds TEXT NOT NULL,
      token_env TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coletas (
      id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      period TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      coleta_id TEXT NOT NULL,
      period TEXT NOT NULL,
      currency TEXT NOT NULL,
      payload TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS snapshots_imutavel_u BEFORE UPDATE ON snapshots
      BEGIN SELECT RAISE(ABORT, 'Snapshot é imutável'); END;
    CREATE TRIGGER IF NOT EXISTS snapshots_imutavel_d BEFORE DELETE ON snapshots
      BEGIN SELECT RAISE(ABORT, 'Snapshot é imutável'); END;
  `);
  const proximo = (tabela: string) => (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ${tabela}`).get() as { n: number }).n;
  const insColetor = db.prepare(`INSERT INTO coletores (${COLETOR}, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const umColetor = db.prepare(`SELECT ${COLETOR} FROM coletores WHERE id = ?`);
  const todosColetores = db.prepare(`SELECT ${COLETOR} FROM coletores ORDER BY seq`);
  const insColeta = db.prepare("INSERT INTO coletas (id, coletor_id, period, state, created_at, seq) VALUES (?, ?, ?, 'em andamento', ?, ?)");
  const fimColeta = db.prepare("UPDATE coletas SET state = ?, error = ?, finished_at = ? WHERE id = ?");
  const umaColeta = db.prepare("SELECT id, coletor_id, period, state, error, created_at, finished_at FROM coletas WHERE id = ?");
  const coletasDoColetor = db.prepare("SELECT id, coletor_id, period, state, error, created_at, finished_at FROM coletas WHERE coletor_id = ? ORDER BY seq");
  const interrompe = db.prepare("UPDATE coletas SET state = 'falhou', error = 'Interrompida (daemon reiniciou)', finished_at = ? WHERE state = 'em andamento'");
  const insSnapshot = db.prepare("INSERT INTO snapshots (id, coletor_id, coleta_id, period, currency, payload, hash, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const umSnapshot = db.prepare("SELECT * FROM snapshots WHERE id = ?");
  const snapshotsDaColeta = db.prepare("SELECT id FROM snapshots WHERE coleta_id = ? ORDER BY seq");
  // Mais recente de cada período (a recoleta não apaga o antigo).
  const recentes = db.prepare(
    `SELECT s.* FROM snapshots s
     WHERE s.coletor_id = ? AND s.seq = (SELECT MAX(seq) FROM snapshots WHERE coletor_id = s.coletor_id AND period = s.period)
     ORDER BY s.period`,
  );

  const coleta = (r: Record<string, unknown> | undefined): Coleta | undefined =>
    r && {
      id: r.id as string,
      coletorId: r.coletor_id as string,
      period: r.period as string,
      state: r.state as EstadoColeta,
      error: (r.error as string | null) ?? null,
      snapshots: (snapshotsDaColeta.all(r.id as string) as { id: string }[]).map((s) => s.id),
      createdAt: r.created_at as string,
      finishedAt: (r.finished_at as string | null) ?? null,
    };

  return {
    criarColetor(e: EntradaColetor): Coletor {
      const id = randomUUID();
      insColetor.run(id, e.contextId, e.source, e.frequency, JSON.stringify(e.params), e.recollectWindowDays, e.automaticAnalysis ? 1 : 0,
        JSON.stringify(e.thresholds), e.tokenEnv, new Date().toISOString(), proximo("coletores"));
      return linhaColetor(umColetor.get(id) as Record<string, unknown>);
    },
    obterColetor: (id: string) => {
      const r = umColetor.get(id) as Record<string, unknown> | undefined;
      return r && linhaColetor(r);
    },
    listarColetores: () => (todosColetores.all() as Record<string, unknown>[]).map(linhaColetor),
    iniciarColeta(coletorId: string, period: string, agora: Date): Coleta {
      const id = randomUUID();
      insColeta.run(id, coletorId, period, agora.toISOString(), proximo("coletas"));
      return coleta(umaColeta.get(id) as Record<string, unknown>)!;
    },
    obterColeta: (id: string) => coleta(umaColeta.get(id) as Record<string, unknown> | undefined),
    listarColetas: (coletorId: string) => (coletasDoColetor.all(coletorId) as Record<string, unknown>[]).map((r) => coleta(r)!),
    /** Conclui a Coleta; o texto do erro é mascarado (ADR-0001/0007). */
    concluirColeta(id: string, erro: string | null, agora: Date) {
      fimColeta.run(erro === null ? "concluída" : "falhou", erro === null ? null : mascarar(erro), agora.toISOString(), id);
    },
    /** Boot: Coletas "em andamento" de um daemon anterior viram "falhou". */
    interromperPendentes: (agora: Date) => void interrompe.run(agora.toISOString()),
    gravarSnapshot(s: Omit<Snapshot, "id" | "createdAt">, agora: Date): Snapshot {
      const id = randomUUID();
      insSnapshot.run(id, s.coletorId, s.coletaId, s.period, s.currency, JSON.stringify(s.payload), s.hash, agora.toISOString(), proximo("snapshots"));
      return linhaSnapshot(umSnapshot.get(id) as Record<string, unknown>);
    },
    obterSnapshot: (id: string) => {
      const r = umSnapshot.get(id) as Record<string, unknown> | undefined;
      return r && linhaSnapshot(r);
    },
    /** Snapshot mais recente de cada período, em ordem de período. */
    maisRecentes: (coletorId: string) => (recentes.all(coletorId) as Record<string, unknown>[]).map(linhaSnapshot),
    close: () => db.close(),
  };
}
export type ArmazemColetas = ReturnType<typeof abrirColetas>;
