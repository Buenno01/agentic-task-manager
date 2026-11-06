import { DatabaseSync } from "node:sqlite";

/** Persistência das Dependências brandas "B depende de A" (conexão própria, mesmo arquivo SQLite). */
export function abrirDependencias(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tarefa_dependencias (
      tarefa_id TEXT NOT NULL,
      depende_de TEXT NOT NULL,
      PRIMARY KEY (tarefa_id, depende_de)
    );
  `);
  const ins = db.prepare("INSERT INTO tarefa_dependencias (tarefa_id, depende_de) VALUES (?, ?)");
  const del = db.prepare("DELETE FROM tarefa_dependencias WHERE tarefa_id = ? AND depende_de = ?");
  const de = db.prepare("SELECT depende_de AS id FROM tarefa_dependencias WHERE tarefa_id = ? ORDER BY rowid");
  const dep = db.prepare("SELECT tarefa_id AS id FROM tarefa_dependencias WHERE depende_de = ? ORDER BY rowid");
  const ids = (rows: unknown[]) => (rows as { id: string }[]).map((r) => r.id);
  return {
    adicionar: (b: string, a: string) => void ins.run(b, a),
    /** Retorna false se a dependência não existia. */
    remover: (b: string, a: string) => Number(del.run(b, a).changes) > 0,
    /** Tarefas das quais `b` depende. */
    dependeDe: (b: string) => ids(de.all(b)),
    /** Tarefas que dependem de `a`. */
    dependentes: (a: string) => ids(dep.all(a)),
    close: () => db.close(),
  };
}
