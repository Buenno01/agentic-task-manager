import { DatabaseSync } from "node:sqlite";

/** Elo (Coletor, categoria) → Tarefa criada pela falha. A mais recente do par é a que vale para o dedup. */
export function abrirFalhasHumanas(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS falhas_humanas (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      coletor_id TEXT NOT NULL,
      categoria TEXT NOT NULL,
      tarefa_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const ins = db.prepare("INSERT INTO falhas_humanas (coletor_id, categoria, tarefa_id, created_at) VALUES (?, ?, ?, ?)");
  const ult = db.prepare("SELECT tarefa_id FROM falhas_humanas WHERE coletor_id = ? AND categoria = ? ORDER BY seq DESC LIMIT 1");
  return {
    vincular: (coletorId: string, categoria: string, tarefaId: string, agora: Date) => void ins.run(coletorId, categoria, tarefaId, agora.toISOString()),
    ultimaTarefa: (coletorId: string, categoria: string): string | undefined =>
      (ult.get(coletorId, categoria) as { tarefa_id: string } | undefined)?.tarefa_id,
    close: () => db.close(),
  };
}
export type ArmazemFalhasHumanas = ReturnType<typeof abrirFalhasHumanas>;
