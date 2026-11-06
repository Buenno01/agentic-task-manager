import { DatabaseSync } from "node:sqlite";

export interface RegistroAuditoria {
  id: number;
  em: string;
  autor: string;
  metodo: string;
  caminho: string;
  status: number;
}

/** Auditoria de ações: quem (humano ou agente) fez o quê. Nunca guarda tokens. */
export function abrirAuditoria(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      em TEXT NOT NULL,
      autor TEXT NOT NULL,
      metodo TEXT NOT NULL,
      caminho TEXT NOT NULL,
      status INTEGER NOT NULL
    );
  `);
  const ins = db.prepare("INSERT INTO auditoria (em, autor, metodo, caminho, status) VALUES (?, ?, ?, ?, ?)");
  const sel = db.prepare("SELECT id, em, autor, metodo, caminho, status FROM auditoria ORDER BY id");
  return {
    registrar: (autor: string, metodo: string, caminho: string, status: number) =>
      void ins.run(new Date().toISOString(), autor, metodo, caminho, status),
    listar: () => sel.all() as unknown as RegistroAuditoria[],
    close: () => db.close(),
  };
}
export type Auditoria = ReturnType<typeof abrirAuditoria>;
