import { DatabaseSync } from "node:sqlite";

export interface AchadoTexto {
  id: string;
  /** Tarefa dona do texto (a própria Tarefa, ou a do comentário). */
  tarefaId: string;
  trecho: string;
}

/** Converte a consulta do usuário em MATCH FTS5 seguro: cada palavra vira frase entre aspas (AND implícito). */
export function consultaFts(consulta: string): string | null {
  const termos = consulta.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return termos.length ? termos.map((t) => `"${t}"`).join(" ") : null;
}

/**
 * Índices FTS5 de Tarefas (título + descrição) e comentários (busca textual), mantidos por TRIGGERS
 * nas tabelas `tarefas` e `tarefa_comentarios` — qualquer caminho de escrita (inclusive criação direta na
 * Execução) fica indexado. Ao abrir, linhas que já existiam antes dos índices são indexadas (backfill).
 * Deve ser aberto DEPOIS de abrirBanco/abrirComentarios (as tabelas-base precisam existir).
 */
export function abrirBusca(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE VIRTUAL TABLE IF NOT EXISTS tarefas_fts USING fts5(
      title, description, tarefa_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS comentarios_fts USING fts5(
      texto, comentario_id UNINDEXED, tarefa_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS tarefas_fts_ai AFTER INSERT ON tarefas BEGIN
      INSERT INTO tarefas_fts (title, description, tarefa_id) VALUES (new.title, new.description, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS tarefas_fts_au AFTER UPDATE OF title, description ON tarefas BEGIN
      DELETE FROM tarefas_fts WHERE tarefa_id = old.id;
      INSERT INTO tarefas_fts (title, description, tarefa_id) VALUES (new.title, new.description, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS tarefas_fts_ad AFTER DELETE ON tarefas BEGIN
      DELETE FROM tarefas_fts WHERE tarefa_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS comentarios_fts_ai AFTER INSERT ON tarefa_comentarios BEGIN
      INSERT INTO comentarios_fts (texto, comentario_id, tarefa_id) VALUES (new.texto, new.id, new.tarefa_id);
    END;
    INSERT INTO tarefas_fts (title, description, tarefa_id)
      SELECT title, description, id FROM tarefas WHERE id NOT IN (SELECT tarefa_id FROM tarefas_fts);
    INSERT INTO comentarios_fts (texto, comentario_id, tarefa_id)
      SELECT texto, id, tarefa_id FROM tarefa_comentarios WHERE id NOT IN (SELECT comentario_id FROM comentarios_fts);
  `);
  const tarefasSql = db.prepare(
    `SELECT tarefa_id AS id, tarefa_id AS tarefaId, snippet(tarefas_fts, -1, '[', ']', '…', 12) AS trecho
     FROM tarefas_fts WHERE tarefas_fts MATCH ? ORDER BY rank, tarefa_id`,
  );
  const comentariosSql = db.prepare(
    `SELECT comentario_id AS id, tarefa_id AS tarefaId, snippet(comentarios_fts, 0, '[', ']', '…', 12) AS trecho
     FROM comentarios_fts WHERE comentarios_fts MATCH ? ORDER BY rank, comentario_id`,
  );
  return {
    tarefas(consulta: string): AchadoTexto[] {
      const m = consultaFts(consulta);
      return m ? (tarefasSql.all(m) as unknown as AchadoTexto[]) : [];
    },
    comentarios(consulta: string): AchadoTexto[] {
      const m = consultaFts(consulta);
      return m ? (comentariosSql.all(m) as unknown as AchadoTexto[]) : [];
    },
    close: () => db.close(),
  };
}
export type ArmazemBusca = ReturnType<typeof abrirBusca>;
