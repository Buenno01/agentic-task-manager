import { DatabaseSync } from "node:sqlite";

/**
 * Registro da Análise de monitoramento: quais Tarefas de análise pertencem a qual Coletor e quais
 * fechamentos de período já foram processados (para não repetir nem pular no boot).
 */
export function abrirAnalises(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS analise_tarefas (
      tarefa_id TEXT PRIMARY KEY,
      coletor_id TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analise_fechamentos (
      coletor_id TEXT NOT NULL,
      chave TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (coletor_id, chave)
    );
  `);
  const insTarefa = db.prepare("INSERT INTO analise_tarefas (tarefa_id, coletor_id, seq) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM analise_tarefas))");
  const doColetor = db.prepare("SELECT tarefa_id AS tarefaId FROM analise_tarefas WHERE coletor_id = ? ORDER BY seq DESC");
  const insFech = db.prepare("INSERT OR IGNORE INTO analise_fechamentos (coletor_id, chave, created_at) VALUES (?, ?, ?)");
  const ultimaFech = db.prepare("SELECT MAX(chave) AS chave FROM analise_fechamentos WHERE coletor_id = ?");
  return {
    vincularTarefa: (tarefaId: string, coletorId: string) => void insTarefa.run(tarefaId, coletorId),
    /** Tarefas de análise do Coletor, da mais recente para a mais antiga. */
    tarefasDoColetor: (coletorId: string) => (doColetor.all(coletorId) as { tarefaId: string }[]).map((r) => r.tarefaId),
    registrarFechamento: (coletorId: string, chave: string, agora: Date) => void insFech.run(coletorId, chave, agora.toISOString()),
    ultimoFechamento: (coletorId: string) => (ultimaFech.get(coletorId) as { chave: string | null }).chave ?? undefined,
    close: () => db.close(),
  };
}
export type ArmazemAnalises = ReturnType<typeof abrirAnalises>;
