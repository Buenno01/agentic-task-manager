import { DatabaseSync } from "node:sqlite";
import type { Contexto } from "../domain/contexto.ts";

/** Persistência de Contextos e da associação Tarefa→Contexto (conexão própria, mesmo arquivo SQLite). */
export function abrirContextos(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS contextos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT REFERENCES contextos(id),
      instructions TEXT NOT NULL DEFAULT '',
      repository TEXT,
      test_commands TEXT,
      concurrency_limit INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tarefa_contexto (
      tarefa_id TEXT PRIMARY KEY,
      contexto_id TEXT NOT NULL REFERENCES contextos(id)
    );
  `);
  if (!(db.prepare("PRAGMA table_info(contextos)").all() as { name: string }[]).some((c) => c.name === "reference_repositories"))
    db.exec("ALTER TABLE contextos ADD COLUMN reference_repositories TEXT");
  const cols =
    "id, name, kind, parent_id AS parentId, instructions, repository, reference_repositories AS referenceRepositories, test_commands AS testCommands, concurrency_limit AS concurrencyLimit, created_at AS createdAt";
  type Row = Omit<Contexto, "testCommands" | "referenceRepositories"> & { testCommands: string | null; referenceRepositories: string | null };
  const paraContexto = (r: Row): Contexto => ({
    ...r,
    testCommands: r.testCommands === null ? null : JSON.parse(r.testCommands),
    referenceRepositories: r.referenceRepositories === null ? null : JSON.parse(r.referenceRepositories),
  });
  const q = {
    insert: db.prepare(
      "INSERT INTO contextos (id, name, kind, parent_id, instructions, repository, test_commands, concurrency_limit, created_at, reference_repositories) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ),
    update: db.prepare(
      "UPDATE contextos SET name=?, kind=?, instructions=?, repository=?, test_commands=?, concurrency_limit=?, reference_repositories=? WHERE id=?",
    ),
    one: db.prepare(`SELECT ${cols} FROM contextos WHERE id = ?`),
    all: db.prepare(`SELECT ${cols} FROM contextos ORDER BY created_at, rowid`),
    tarefaExiste: db.prepare("SELECT 1 FROM tarefas WHERE id = ?"),
    associar: db.prepare(
      "INSERT INTO tarefa_contexto (tarefa_id, contexto_id) VALUES (?, ?) ON CONFLICT(tarefa_id) DO UPDATE SET contexto_id = excluded.contexto_id",
    ),
    desassociar: db.prepare("DELETE FROM tarefa_contexto WHERE tarefa_id = ?"),
    mapa: db.prepare("SELECT tarefa_id AS tarefaId, contexto_id AS contextoId FROM tarefa_contexto"),
    contextoDa: db.prepare("SELECT contexto_id AS contextoId FROM tarefa_contexto WHERE tarefa_id = ?"),
  };
  return {
    inserir(c: Contexto) {
      q.insert.run(c.id, c.name, c.kind, c.parentId, c.instructions, c.repository,
        c.testCommands === null ? null : JSON.stringify(c.testCommands), c.concurrencyLimit, c.createdAt,
        c.referenceRepositories === null ? null : JSON.stringify(c.referenceRepositories));
    },
    atualizar(c: Contexto) {
      q.update.run(c.name, c.kind, c.instructions, c.repository,
        c.testCommands === null ? null : JSON.stringify(c.testCommands), c.concurrencyLimit,
        c.referenceRepositories === null ? null : JSON.stringify(c.referenceRepositories), c.id);
    },
    obter: (id: string): Contexto | undefined => {
      const r = q.one.get(id) as Row | undefined;
      return r && paraContexto(r);
    },
    listar: (): Contexto[] => (q.all.all() as unknown as Row[]).map(paraContexto),
    tarefaExiste: (id: string) => q.tarefaExiste.get(id) !== undefined,
    associarTarefa(tarefaId: string, contextoId: string | null) {
      if (contextoId === null) q.desassociar.run(tarefaId);
      else q.associar.run(tarefaId, contextoId);
    },
    contextoDaTarefa: (tarefaId: string): string | null =>
      (q.contextoDa.get(tarefaId) as { contextoId: string } | undefined)?.contextoId ?? null,
    mapaTarefaContexto: () => new Map((q.mapa.all() as { tarefaId: string; contextoId: string }[]).map((r) => [r.tarefaId, r.contextoId])),
    close: () => db.close(),
  };
}
export type ArmazemContextos = ReturnType<typeof abrirContextos>;
