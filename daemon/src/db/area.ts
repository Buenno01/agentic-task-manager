import { DatabaseSync } from "node:sqlite";

/** Persistência da Área prevista por Tarefa (conexão própria, mesmo arquivo SQLite). */
export function abrirArea(path: string, mascarar: (s: string) => string = (s) => s) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tarefa_area (
      tarefa_id TEXT PRIMARY KEY,
      paths TEXT NOT NULL
    );
  `);
  const sel = db.prepare("SELECT paths FROM tarefa_area WHERE tarefa_id = ?");
  const todas = db.prepare("SELECT tarefa_id AS id, paths FROM tarefa_area");
  const up = db.prepare(
    "INSERT INTO tarefa_area (tarefa_id, paths) VALUES (?, ?) ON CONFLICT(tarefa_id) DO UPDATE SET paths = excluded.paths",
  );
  const ev = db.prepare(
    "INSERT INTO tarefa_eventos (tarefa_id, em, autor, tipo, de, para, motivo) VALUES (?, ?, ?, 'area-prevista', ?, ?, ?)",
  );
  return {
    obter: (id: string): string[] => {
      const r = sel.get(id) as { paths: string } | undefined;
      return r ? JSON.parse(r.paths) : [];
    },
    mapa: () => new Map((todas.all() as { id: string; paths: string }[]).map((r) => [r.id, JSON.parse(r.paths) as string[]])),
    /** Grava a Área e o evento no histórico (estado inalterado). */
    definir(id: string, bruto: string[], autor: string, estado: string) {
      const paths = bruto.map((p) => mascarar(p));
      db.exec("BEGIN");
      try {
        up.run(id, JSON.stringify(paths));
        ev.run(id, new Date().toISOString(), autor, estado, estado, paths.join(", "));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => db.close(),
  };
}
export type ArmazemArea = ReturnType<typeof abrirArea>;
