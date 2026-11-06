import { DatabaseSync } from "node:sqlite";
import type { Tarefa } from "../domain/tarefa.ts";
import { agora } from "../domain/historico.ts";

/** Histórico de uma Tarefa (ticket 05 estende com comentários etc.). Nunca é apagado. */
export interface EventoTarefa {
  id: number;
  tarefaId: string;
  em: string;
  autor: string;
  tipo: string;
  de: string;
  para: string;
  motivo: string;
}

export interface Repositorio {
  inserirTarefa(t: Tarefa): void;
  listarTarefas(): Tarefa[];
  obterTarefa(id: string): Tarefa | undefined;
  /** Muda o estado e grava o evento na mesma transação. */
  transicionar(id: string, ev: { autor: string; tipo: string; de: string; para: string; motivo: string }): void;
  listarEventos(id: string): EventoTarefa[];
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
    CREATE TABLE IF NOT EXISTS tarefa_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarefa_id TEXT NOT NULL,
      em TEXT NOT NULL,
      autor TEXT NOT NULL,
      tipo TEXT NOT NULL,
      de TEXT NOT NULL DEFAULT '',
      para TEXT NOT NULL DEFAULT '',
      motivo TEXT NOT NULL DEFAULT ''
    );
  `);
  const insert = db.prepare(
    "INSERT INTO tarefas (id, title, description, phase, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const select = db.prepare(
    "SELECT id, title, description, phase, state, created_at AS createdAt FROM tarefas ORDER BY created_at, rowid",
  );
  const um = db.prepare(
    "SELECT id, title, description, phase, state, created_at AS createdAt FROM tarefas WHERE id = ?",
  );
  const upd = db.prepare("UPDATE tarefas SET state = ? WHERE id = ?");
  const insEv = db.prepare(
    "INSERT INTO tarefa_eventos (tarefa_id, em, autor, tipo, de, para, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selEv = db.prepare(
    "SELECT id, tarefa_id AS tarefaId, em, autor, tipo, de, para, motivo FROM tarefa_eventos WHERE tarefa_id = ? ORDER BY id",
  );
  return {
    obterTarefa: (id) => um.get(id) as unknown as Tarefa | undefined,
    transicionar: (id, e) => {
      db.exec("BEGIN");
      try {
        upd.run(e.para, id);
        insEv.run(id, agora(), e.autor, e.tipo, e.de, e.para, e.motivo);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    listarEventos: (id) => selEv.all(id) as unknown as EventoTarefa[],
    inserirTarefa: (t) => void insert.run(t.id, t.title, t.description, t.phase, t.state, t.createdAt),
    listarTarefas: () => select.all() as unknown as Tarefa[],
    close: () => db.close(),
  };
}
