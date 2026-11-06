import { DatabaseSync } from "node:sqlite";
import { PRIORIDADE_PADRAO, type Justificativa, type Nivel, type Prioridade } from "../domain/prioridade.ts";

/** Prioridade vigente por Tarefa, com autor. Tarefas sem linha usam o padrão (média). */
export function abrirPrioridades(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS prioridades (
      tarefa_id TEXT PRIMARY KEY,
      nivel TEXT NOT NULL,
      impacto TEXT NOT NULL DEFAULT '',
      urgencia TEXT NOT NULL DEFAULT '',
      esforco TEXT NOT NULL DEFAULT '',
      origem TEXT NOT NULL,
      autor TEXT NOT NULL,
      em TEXT NOT NULL
    );
  `);
  const sel = db.prepare(
    "SELECT nivel, impacto, urgencia, esforco, origem, autor, em FROM prioridades WHERE tarefa_id = ?",
  );
  const up = db.prepare(
    `INSERT INTO prioridades (tarefa_id, nivel, impacto, urgencia, esforco, origem, autor, em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tarefa_id) DO UPDATE SET nivel = excluded.nivel, impacto = excluded.impacto,
       urgencia = excluded.urgencia, esforco = excluded.esforco, origem = excluded.origem,
       autor = excluded.autor, em = excluded.em`,
  );
  const obter = (id: string): Prioridade => {
    const r = sel.get(id) as any;
    if (!r) return PRIORIDADE_PADRAO;
    return {
      nivel: r.nivel,
      justificativa: { impacto: r.impacto, urgencia: r.urgencia, esforco: r.esforco },
      origem: r.origem,
      autor: r.autor,
      em: r.em,
    };
  };
  return {
    obter,
    definir: (id: string, nivel: Nivel, j: Justificativa, origem: "humano" | "agente", autor: string) =>
      void up.run(id, nivel, j.impacto, j.urgencia, j.esforco, origem, autor, new Date().toISOString()),
    close: () => db.close(),
  };
}
export type Prioridades = ReturnType<typeof abrirPrioridades>;
