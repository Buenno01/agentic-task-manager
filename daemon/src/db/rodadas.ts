import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { agora } from "../domain/historico.ts";

export type EstadoRodada = "em andamento" | "concluída" | "falhou" | "interrompida" | "cancelada";

export interface Segmento {
  id: string;
  seq: number;
  modelo: string | null;
  provedor: string | null;
  tokensEntrada: number | null;
  tokensSaida: number | null;
  chamadas: number | null;
  custoEstimado: number | null;
  /** Verdadeiro quando nenhum uso foi medido (nunca falha a Rodada). */
  usoDesconhecido: boolean;
}

export interface EventoRodada {
  id: number;
  em: string;
  tipo: string;
  dados: Record<string, unknown>;
}

export interface Rodada {
  id: string;
  tarefaId: string;
  tipo: string;
  estado: EstadoRodada;
  iniciadaEm: string;
  terminadaEm: string | null;
  erro: string | null;
  workspace: string;
  segmentos: Segmento[];
  eventos: EventoRodada[];
}

/** Rodadas, Segmentos e eventos no SQLite. Só INSERT/UPDATE de estado: nada é apagado. */
export function abrirRodadas(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rodadas (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      tarefa_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      estado TEXT NOT NULL,
      iniciada_em TEXT NOT NULL,
      terminada_em TEXT,
      erro TEXT,
      workspace TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rodada_segmentos (
      id TEXT PRIMARY KEY,
      rodada_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      modelo TEXT,
      provedor TEXT,
      tokens_entrada INTEGER,
      tokens_saida INTEGER,
      chamadas INTEGER,
      custo_estimado REAL
    );
    CREATE TABLE IF NOT EXISTS rodada_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rodada_id TEXT NOT NULL,
      em TEXT NOT NULL,
      tipo TEXT NOT NULL,
      dados TEXT NOT NULL
    );
  `);
  const insR = db.prepare(
    "INSERT INTO rodadas (id, seq, tarefa_id, tipo, estado, iniciada_em, workspace) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM rodadas), ?, ?, 'em andamento', ?, ?)",
  );
  const colsR = "id, tarefa_id AS tarefaId, tipo, estado, iniciada_em AS iniciadaEm, terminada_em AS terminadaEm, erro, workspace";
  const umaR = db.prepare(`SELECT ${colsR} FROM rodadas WHERE id = ?`);
  const daTarefa = db.prepare(`SELECT ${colsR} FROM rodadas WHERE tarefa_id = ? ORDER BY seq`);
  const ativa = db.prepare(`SELECT id FROM rodadas WHERE tarefa_id = ? AND estado = 'em andamento' ORDER BY seq DESC LIMIT 1`);
  const fim = db.prepare("UPDATE rodadas SET estado = ?, terminada_em = ?, erro = ? WHERE id = ?");
  const segs = db.prepare(
    "SELECT id, seq, modelo, provedor, tokens_entrada AS tokensEntrada, tokens_saida AS tokensSaida, chamadas, custo_estimado AS custoEstimado FROM rodada_segmentos WHERE rodada_id = ? ORDER BY seq",
  );
  const insS = db.prepare(
    "INSERT INTO rodada_segmentos (id, rodada_id, seq, modelo, provedor) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM rodada_segmentos WHERE rodada_id = ?), ?, ?)",
  );
  const ultimoS = db.prepare("SELECT id FROM rodada_segmentos WHERE rodada_id = ? ORDER BY seq DESC LIMIT 1");
  const somaS = db.prepare(
    "UPDATE rodada_segmentos SET tokens_entrada = COALESCE(tokens_entrada, 0) + ?, tokens_saida = COALESCE(tokens_saida, 0) + ?, chamadas = COALESCE(chamadas, 0) + ?, custo_estimado = CASE WHEN ? IS NULL THEN custo_estimado ELSE COALESCE(custo_estimado, 0) + ? END WHERE id = ?",
  );
  const evs = db.prepare("SELECT id, em, tipo, dados FROM rodada_eventos WHERE rodada_id = ? ORDER BY id");
  const insE = db.prepare("INSERT INTO rodada_eventos (rodada_id, em, tipo, dados) VALUES (?, ?, ?, ?)");

  const completa = (r: Record<string, unknown>): Rodada => ({
    ...(r as unknown as Rodada),
    segmentos: (segs.all(r.id as string) as Record<string, unknown>[]).map((s) => ({
      ...(s as unknown as Segmento),
      usoDesconhecido: s.tokensEntrada === null,
    })),
    eventos: (evs.all(r.id as string) as Record<string, unknown>[]).map((e) => ({
      ...(e as unknown as EventoRodada),
      dados: JSON.parse(e.dados as string),
    })),
  });

  const abrirSegmento = (rodadaId: string, s: { modelo: string | null; provedor: string | null }) => {
    const id = randomUUID();
    insS.run(id, rodadaId, rodadaId, s.modelo, s.provedor);
    return id;
  };
  return {
    criar(r: { tarefaId: string; tipo: string; workspace: string }): Rodada {
      const id = randomUUID();
      insR.run(id, r.tarefaId, r.tipo, agora(), r.workspace);
      return completa(umaR.get(id) as Record<string, unknown>);
    },
    obter: (id: string) => {
      const r = umaR.get(id) as Record<string, unknown> | undefined;
      return r && completa(r);
    },
    listarDaTarefa: (tarefaId: string) => (daTarefa.all(tarefaId) as Record<string, unknown>[]).map(completa),
    ativaDaTarefa: (tarefaId: string) => (ativa.get(tarefaId) as { id: string } | undefined)?.id,
    finalizar: (id: string, estado: EstadoRodada, erro?: string) => void fim.run(estado, agora(), erro ?? null, id),
    registrarEvento: (rodadaId: string, tipo: string, dados: Record<string, unknown>) =>
      void insE.run(rodadaId, agora(), tipo, JSON.stringify(dados)),
    abrirSegmento,
    /** Soma uso ao Segmento atual; abre um Segmento sem modelo se ainda não houver. */
    somarUso(rodadaId: string, u: { entrada: number; saida: number; chamadas?: number; custo?: number }) {
      const atual = (ultimoS.get(rodadaId) as { id: string } | undefined)?.id ?? abrirSegmento(rodadaId, { modelo: null, provedor: null });
      somaS.run(u.entrada, u.saida, u.chamadas ?? 0, u.custo ?? null, u.custo ?? null, atual);
    },
    close: () => db.close(),
  };
}
export type ArmazemRodadas = ReturnType<typeof abrirRodadas>;
