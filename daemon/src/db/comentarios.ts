import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { agora, type ItemHistorico, type TipoComentario } from "../domain/historico.ts";

export interface Comentarios {
  inserir(c: { tarefaId: string; autor: string; tipo: TipoComentario; texto: string; respondeA?: string }): ItemHistorico;
  obter(id: string): ItemHistorico | undefined;
  listar(tarefaId: string): ItemHistorico[];
  close(): void;
}

/** Comentários só têm INSERT e SELECT: o histórico não é editável nem apagável. */
export function abrirComentarios(path: string): Comentarios {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tarefa_comentarios (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      tarefa_id TEXT NOT NULL,
      em TEXT NOT NULL,
      autor TEXT NOT NULL,
      tipo TEXT NOT NULL,
      texto TEXT NOT NULL,
      responde_a TEXT
    );
  `);
  const cols =
    "id, tarefa_id AS tarefaId, em, autor, tipo, texto, responde_a AS respondeA";
  const ins = db.prepare(
    "INSERT INTO tarefa_comentarios (id, seq, tarefa_id, em, autor, tipo, texto, responde_a) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tarefa_comentarios), ?, ?, ?, ?, ?, ?)",
  );
  const um = db.prepare(`SELECT ${cols} FROM tarefa_comentarios WHERE id = ?`);
  const todos = db.prepare(`SELECT ${cols} FROM tarefa_comentarios WHERE tarefa_id = ? ORDER BY seq`);
  const item = (r: Record<string, unknown>): ItemHistorico => {
    const { respondeA, ...resto } = r;
    return { de: "", para: "", motivo: "", ...resto, ...(respondeA ? { respondeA } : {}) } as unknown as ItemHistorico;
  };
  return {
    inserir: (c) => {
      const id = randomUUID();
      ins.run(id, c.tarefaId, agora(), c.autor, c.tipo, c.texto, c.respondeA ?? null);
      return item(um.get(id) as Record<string, unknown>);
    },
    obter: (id) => {
      const r = um.get(id) as Record<string, unknown> | undefined;
      return r && item(r);
    },
    listar: (tarefaId) => (todos.all(tarefaId) as Record<string, unknown>[]).map(item),
    close: () => db.close(),
  };
}
