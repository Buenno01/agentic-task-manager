import { DatabaseSync } from "node:sqlite";
import type { Tarefa } from "../domain/tarefa.ts";
import { VAZIO, type DadosExecucao } from "../domain/execucao.ts";

interface Linha {
  objetivo: string;
  repositorio: string;
  criterios: string;
  entregaveis: string;
  permissoes: string;
  pulada: number;
}

/** Tabela lateral `tarefa_execucao` (conexão própria, mesmo arquivo SQLite). */
export function abrirExecucao(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tarefa_execucao (
      tarefa_id TEXT PRIMARY KEY,
      objetivo TEXT NOT NULL DEFAULT '',
      repositorio TEXT NOT NULL DEFAULT '',
      criterios TEXT NOT NULL DEFAULT '[]',
      entregaveis TEXT NOT NULL DEFAULT '[]',
      permissoes TEXT NOT NULL DEFAULT '[]',
      pulada INTEGER NOT NULL DEFAULT 0
    );
  `);
  const sel = db.prepare(
    "SELECT objetivo, repositorio, criterios, entregaveis, permissoes, pulada FROM tarefa_execucao WHERE tarefa_id = ?",
  );
  const up = db.prepare(
    `INSERT INTO tarefa_execucao (tarefa_id, objetivo, repositorio, criterios, entregaveis, permissoes, pulada)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tarefa_id) DO UPDATE SET objetivo=excluded.objetivo, repositorio=excluded.repositorio,
       criterios=excluded.criterios, entregaveis=excluded.entregaveis, permissoes=excluded.permissoes, pulada=excluded.pulada`,
  );
  const insTarefa = db.prepare(
    "INSERT INTO tarefas (id, title, description, phase, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const mudaFase = db.prepare("UPDATE tarefas SET phase = ?, state = ? WHERE id = ?");
  const insEv = db.prepare(
    "INSERT INTO tarefa_eventos (tarefa_id, em, autor, tipo, de, para, motivo) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  type Ev = { autor: string; tipo: string; de: string; para: string; motivo: string };
  /** Tudo na mesma transação: histórico nunca é apagado, só ganha eventos. */
  const atomico = (f: () => void) => {
    db.exec("BEGIN");
    try {
      f();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const evento = (id: string, e: Ev) =>
    void insEv.run(id, new Date().toISOString(), e.autor, e.tipo, e.de, e.para, e.motivo);
  return {
    /** Cria direto na Execução (atalho humano), registrando o evento. */
    criarDireto(t: Tarefa, d: DadosExecucao, e: Ev) {
      atomico(() => {
        insTarefa.run(t.id, t.title, t.description, t.phase, t.state, t.createdAt);
        up.run(t.id, d.objetivo, d.repositorioPrincipal, JSON.stringify(d.criterios), JSON.stringify(d.entregaveis), JSON.stringify(d.permissoes), d.puladaExploracao ? 1 : 0);
        evento(t.id, e);
      });
    },
    /** Muda fase+estado, grava os dados e o evento (conversão e devolução à Aprovação). */
    mover(id: string, fase: string, estado: string, d: DadosExecucao, e: Ev) {
      atomico(() => {
        mudaFase.run(fase, estado, id);
        up.run(id, d.objetivo, d.repositorioPrincipal, JSON.stringify(d.criterios), JSON.stringify(d.entregaveis), JSON.stringify(d.permissoes), d.puladaExploracao ? 1 : 0);
        evento(id, e);
      });
    },
    obter(id: string): DadosExecucao {
      const r = sel.get(id) as unknown as Linha | undefined;
      if (!r) return { ...VAZIO };
      return {
        objetivo: r.objetivo,
        repositorioPrincipal: r.repositorio,
        criterios: JSON.parse(r.criterios),
        entregaveis: JSON.parse(r.entregaveis),
        permissoes: JSON.parse(r.permissoes),
        puladaExploracao: r.pulada === 1,
      };
    },
    salvar(id: string, d: DadosExecucao) {
      up.run(
        id, d.objetivo, d.repositorioPrincipal, JSON.stringify(d.criterios), JSON.stringify(d.entregaveis),
        JSON.stringify(d.permissoes), d.puladaExploracao ? 1 : 0,
      );
    },
    close: () => db.close(),
  };
}
export type ArmazemExecucao = ReturnType<typeof abrirExecucao>;
