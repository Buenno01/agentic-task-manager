import { DatabaseSync } from "node:sqlite";
import type { Tarefa } from "../domain/tarefa.ts";

export interface Repositorio {
  inserirTarefa(t: Tarefa): void;
  listarTarefas(): Tarefa[];
  close(): void;
}

export function abrirBanco(path: string): Repositorio {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tarefas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      phase TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO tarefas (id, title, description, phase, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const select = db.prepare(
    "SELECT id, title, description, phase, state, created_at AS createdAt FROM tarefas ORDER BY created_at, rowid",
  );
  return {
    inserirTarefa: (t) => void insert.run(t.id, t.title, t.description, t.phase, t.state, t.createdAt),
    listarTarefas: () => select.all() as unknown as Tarefa[],
    close: () => db.close(),
  };
}
