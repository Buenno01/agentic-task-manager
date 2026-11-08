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
  /** Soma do uso medido dos Segmentos. */
  totais: TotaisUso;
  eventos: EventoRodada[];
}

export interface TotaisUso {
  tokensEntrada: number;
  tokensSaida: number;
  chamadas: number;
  /** Nulo quando nenhum Segmento informou custo. */
  custoEstimado: number | null;
  /** Verdadeiro se algum Segmento (ou a falta de Segmentos) deixa o uso sem medição. */
  usoDesconhecido: boolean;
}

/** Soma o uso medido; Segmentos sem medição contam zero e marcam \"uso desconhecido\". */
export function totaisDeUso(segmentos: Segmento[]): TotaisUso {
  const t: TotaisUso = { tokensEntrada: 0, tokensSaida: 0, chamadas: 0, custoEstimado: null, usoDesconhecido: segmentos.length === 0 };
  for (const s of segmentos) {
    t.tokensEntrada += s.tokensEntrada ?? 0;
    t.tokensSaida += s.tokensSaida ?? 0;
    t.chamadas += s.chamadas ?? 0;
    if (s.custoEstimado !== null) t.custoEstimado = (t.custoEstimado ?? 0) + s.custoEstimado;
    if (s.usoDesconhecido) t.usoDesconhecido = true;
  }
  return t;
}

/** Campos estruturados de um Checkpoint (ADR-0004), escritos pelo agente. */
export interface DadosCheckpoint {
  progresso: string;
  decisoes: string[];
  arquivosTocados: string[];
  proximosPassos: string[];
}

/** Checkpoint (ADR-0004): do agente (campos estruturados) ou automático (SHA e arquivos alterados). */
export interface Checkpoint {
  id: number;
  rodadaId: string;
  tarefaId: string;
  origem: "agente" | "automático";
  em: string;
  /** HEAD do Workspace, gravado pelo sistema. */
  sha: string | null;
  progresso: string | null;
  decisoes: string[];
  arquivosTocados: string[];
  proximosPassos: string[];
}

/** Rodadas, Segmentos e eventos no SQLite. Só INSERT/UPDATE de estado: nada é apagado. */
export function abrirRodadas(path: string, mascarar: (s: string) => string = (s) => s) {
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
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rodada_id TEXT NOT NULL,
      tarefa_id TEXT NOT NULL,
      origem TEXT NOT NULL,
      em TEXT NOT NULL,
      sha TEXT,
      progresso TEXT,
      decisoes TEXT NOT NULL,
      arquivos_tocados TEXT NOT NULL,
      proximos_passos TEXT NOT NULL
    );
  `);
  const insC = db.prepare(
    "INSERT INTO checkpoints (rodada_id, tarefa_id, origem, em, sha, progresso, decisoes, arquivos_tocados, proximos_passos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const cpsDaTarefa = db.prepare(
    "SELECT id, rodada_id AS rodadaId, tarefa_id AS tarefaId, origem, em, sha, progresso, decisoes, arquivos_tocados AS arquivosTocados, proximos_passos AS proximosPassos FROM checkpoints WHERE tarefa_id = ? ORDER BY id",
  );
  const insR = db.prepare(
    "INSERT INTO rodadas (id, seq, tarefa_id, tipo, estado, iniciada_em, workspace) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM rodadas), ?, ?, 'em andamento', ?, ?)",
  );
  const colsR = "id, tarefa_id AS tarefaId, tipo, estado, iniciada_em AS iniciadaEm, terminada_em AS terminadaEm, erro, workspace";
  const umaR = db.prepare(`SELECT ${colsR} FROM rodadas WHERE id = ?`);
  const daTarefa = db.prepare(`SELECT ${colsR} FROM rodadas WHERE tarefa_id = ? ORDER BY seq`);
  const ativa = db.prepare(`SELECT id FROM rodadas WHERE tarefa_id = ? AND estado = 'em andamento' ORDER BY seq DESC LIMIT 1`);
  const todasAtivas = db.prepare("SELECT id, tarefa_id AS tarefaId FROM rodadas WHERE estado = 'em andamento' ORDER BY seq");
  const total = db.prepare("SELECT COUNT(*) AS n FROM rodadas WHERE tarefa_id = ?");
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

  const completa = (r: Record<string, unknown>): Rodada => {
    const segmentos = (segs.all(r.id as string) as Record<string, unknown>[]).map((s) => ({
      ...(s as unknown as Segmento),
      usoDesconhecido: s.tokensEntrada === null,
    }));
    return {
      ...(r as unknown as Rodada),
      segmentos,
      totais: totaisDeUso(segmentos),
      eventos: (evs.all(r.id as string) as Record<string, unknown>[]).map((e) => ({
        ...(e as unknown as EventoRodada),
        dados: JSON.parse(e.dados as string),
      })),
    };
  };

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
    emAndamento: () => todasAtivas.all() as unknown as { id: string; tarefaId: string }[],
    totalDaTarefa: (tarefaId: string) => (total.get(tarefaId) as { n: number }).n,
    finalizar: (id: string, estado: EstadoRodada, erro?: string) => void fim.run(estado, agora(), erro == null ? null : mascarar(erro), id),
    registrarEvento: (rodadaId: string, tipo: string, dados: Record<string, unknown>) =>
      void insE.run(rodadaId, agora(), tipo, mascarar(JSON.stringify(dados))),
    abrirSegmento,
    /** Soma uso ao Segmento atual; abre um Segmento sem modelo se ainda não houver. */
    somarUso(rodadaId: string, u: { entrada: number; saida: number; chamadas?: number; custo?: number }) {
      const atual = (ultimoS.get(rodadaId) as { id: string } | undefined)?.id ?? abrirSegmento(rodadaId, { modelo: null, provedor: null });
      somaS.run(u.entrada, u.saida, u.chamadas ?? 0, u.custo ?? null, u.custo ?? null, atual);
    },
    inserirCheckpoint(c: Omit<Checkpoint, "id" | "em">): Checkpoint {
      const em = agora();
      const r = insC.run(c.rodadaId, c.tarefaId, c.origem, em, c.sha, c.progresso == null ? null : mascarar(c.progresso), mascarar(JSON.stringify(c.decisoes)), mascarar(JSON.stringify(c.arquivosTocados)), mascarar(JSON.stringify(c.proximosPassos)));
      return { ...c, id: Number(r.lastInsertRowid), em };
    },
    /** Checkpoints da Tarefa (de todas as Rodadas), do mais antigo ao mais recente. */
    checkpointsDaTarefa: (tarefaId: string): Checkpoint[] =>
      (cpsDaTarefa.all(tarefaId) as Record<string, unknown>[]).map((c) => ({
        ...(c as unknown as Checkpoint),
        decisoes: JSON.parse(c.decisoes as string),
        arquivosTocados: JSON.parse(c.arquivosTocados as string),
        proximosPassos: JSON.parse(c.proximosPassos as string),
      })),
    close: () => db.close(),
  };
}
export type ArmazemRodadas = ReturnType<typeof abrirRodadas>;
