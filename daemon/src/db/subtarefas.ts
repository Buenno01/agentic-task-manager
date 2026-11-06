import { DatabaseSync } from "node:sqlite";

export type Decisao = "aprovada" | "rejeitada";

export interface LinhaSubtarefa {
  id: string;
  maeId: string;
  decisao: Decisao | null;
}

/** Relação Tarefa-mãe → Subtarefa (tabela lateral; conexão própria, mesmo arquivo SQLite). */
export function abrirSubtarefas(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS subtarefas (
      id TEXT PRIMARY KEY,
      mae_id TEXT NOT NULL,
      decisao TEXT
    );
  `);
  const ins = db.prepare("INSERT INTO subtarefas (id, mae_id) VALUES (?, ?)");
  const dec = db.prepare("UPDATE subtarefas SET decisao = ? WHERE id = ?");
  const um = db.prepare("SELECT id, mae_id AS maeId, decisao FROM subtarefas WHERE id = ?");
  const filhas = db.prepare("SELECT id, mae_id AS maeId, decisao FROM subtarefas WHERE mae_id = ? ORDER BY rowid");
  const edit = db.prepare("UPDATE tarefas SET title = ?, description = ? WHERE id = ?");
  return {
    vincular: (id: string, maeId: string) => void ins.run(id, maeId),
    definirDecisao: (id: string, d: Decisao | null) => void dec.run(d, id),
    obter: (id: string) => um.get(id) as unknown as LinhaSubtarefa | undefined,
    daMae: (maeId: string) => filhas.all(maeId) as unknown as LinhaSubtarefa[],
    editar: (id: string, title: string, description: string) => void edit.run(title, description, id),
    close: () => db.close(),
  };
}
