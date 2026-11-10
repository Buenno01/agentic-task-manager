import { DatabaseSync } from "node:sqlite";

/** Uma versão do Contexto consolidado (RF12). Versões nunca são alteradas nem apagadas. */
export interface VersaoConsolidado {
  contextId: string;
  version: number;
  text: string;
  /** Tarefa de origem; null quando a atualização não veio de uma Tarefa. */
  taskId: string | null;
  /** "humano" ou "agente:<id>". */
  author: string;
  /** Versão restaurada, quando esta versão é uma reversão. */
  revertedFrom: number | null;
  /** Rodada de origem, quando a versão foi gravada por uma Rodada. */
  rodadaId: string | null;
  createdAt: string;
}

export interface TrechoBusca {
  contextId: string;
  version: number;
  trecho: string;
}

const COLUNAS =
  "context_id AS contextId, version, text, task_id AS taskId, author, reverted_from AS revertedFrom, rodada_id AS rodadaId, created_at AS createdAt";

/**
 * Armazém do Contexto consolidado. `consolidado_versoes` guarda o texto de cada versão;
 * `consolidado_fts` (FTS5) indexa esse texto para a busca textual.
 */
export function abrirConsolidado(path: string, mascarar: (s: string) => string = (s) => s) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS consolidado_versoes (
      context_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      task_id TEXT,
      author TEXT NOT NULL,
      reverted_from INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (context_id, version)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS consolidado_fts USING fts5(
      text, context_id UNINDEXED, version UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  // Rodada de origem (RF12): coluna adicionada depois da criação da tabela.
  if (!(db.prepare("PRAGMA table_info(consolidado_versoes)").all() as { name: string }[]).some((c) => c.name === "rodada_id"))
    db.exec("ALTER TABLE consolidado_versoes ADD COLUMN rodada_id TEXT");
  const atualSql = db.prepare(`SELECT ${COLUNAS} FROM consolidado_versoes WHERE context_id = ? ORDER BY version DESC LIMIT 1`);
  const umaSql = db.prepare(`SELECT ${COLUNAS} FROM consolidado_versoes WHERE context_id = ? AND version = ?`);
  const listaSql = db.prepare(`SELECT ${COLUNAS} FROM consolidado_versoes WHERE context_id = ? ORDER BY version`);
  const insSql = db.prepare(
    "INSERT INTO consolidado_versoes (context_id, version, text, task_id, author, reverted_from, rodada_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insFts = db.prepare("INSERT INTO consolidado_fts (text, context_id, version) VALUES (?, ?, ?)");
  const buscaSql = db.prepare(
    `SELECT context_id AS contextId, version, snippet(consolidado_fts, 0, '[', ']', '…', 12) AS trecho
     FROM consolidado_fts WHERE consolidado_fts MATCH ? ORDER BY rank, context_id, version`,
  );

  const atual = (contextId: string) => atualSql.get(contextId) as unknown as VersaoConsolidado | undefined;

  function adicionar(contextId: string, bruto: string, taskId: string | null, author: string, revertedFrom: number | null, rodadaId: string | null) {
    // ADR-0001/0007: segredo conhecido nunca é gravado, nem na versão nem no índice FTS.
    const text = mascarar(bruto);
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = (atual(contextId)?.version ?? 0) + 1;
      insSql.run(contextId, version, text, taskId, author, revertedFrom, rodadaId, new Date().toISOString());
      insFts.run(text, contextId, version);
      db.exec("COMMIT");
      return umaSql.get(contextId, version) as unknown as VersaoConsolidado;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return {
    atual,
    versao: (contextId: string, version: number) =>
      umaSql.get(contextId, version) as unknown as VersaoConsolidado | undefined,
    listar: (contextId: string) => listaSql.all(contextId) as unknown as VersaoConsolidado[],
    atualizar: (contextId: string, text: string, taskId: string | null, author: string, rodadaId: string | null = null) =>
      adicionar(contextId, text, taskId, author, null, rodadaId),
    /** Cria uma NOVA versão com o texto de `version`; o histórico permanece intacto. */
    reverter(contextId: string, version: number, taskId: string | null, author: string, rodadaId: string | null = null) {
      const alvo = umaSql.get(contextId, version) as unknown as VersaoConsolidado | undefined;
      if (!alvo) return undefined;
      return adicionar(contextId, alvo.text, taskId, author, version, rodadaId);
    },
    /** Busca full-text em todas as versões; os termos da consulta são tratados como texto literal. */
    buscar(consulta: string): TrechoBusca[] {
      const termos = consulta.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!termos.length) return [];
      return buscaSql.all(termos.map((t) => `"${t}"`).join(" ")) as unknown as TrechoBusca[];
    },
    close: () => db.close(),
  };
}
export type ArmazemConsolidado = ReturnType<typeof abrirConsolidado>;
