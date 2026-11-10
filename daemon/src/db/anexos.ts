import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extrairTexto } from "../domain/extracao.ts";

export type DonoAnexo = "tarefa" | "contexto";

export interface Anexo {
  id: string;
  ownerType: DonoAnexo;
  ownerId: string;
  name: string;
  mimeType: string;
  size: number;
  hasText: boolean;
  createdAt: string;
}

/** Nome seguro: só o último segmento (sem / ou \), sem controle, sem pontos iniciais, limitado. */
export function sanitizarNome(nome: string): string {
  const base = nome.split(/[\\/]/).pop() ?? "";
  const limpo = base.replace(/[\u0000-\u001f\u007f"]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return limpo || "anexo";
}

/**
 * Anexos (RF13): arquivo em disco sob id gerado (ATM_ATTACHMENTS_DIR), metadados em SQLite
 * e texto extraído indexado em FTS5 (`anexos_fts`) para a busca textual.
 * FTS5 é obrigatório: sem ele a abertura falha com erro claro.
 */
export function abrirAnexos(dbPath: string, dir: string) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS anexos (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      has_text INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS anexos_dono ON anexos(owner_type, owner_id);
  `);
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS anexos_fts USING fts5(texto, anexo_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')",
    );
  } catch (e) {
    throw new Error(`SQLite sem suporte a FTS5, obrigatório para a busca de anexos: ${(e as Error).message}`);
  }
  const cols =
    "id, owner_type AS ownerType, owner_id AS ownerId, name, mime_type AS mimeType, size, has_text AS hasText, created_at AS createdAt";
  const colsA = cols.split(", ").map((c) => "a." + c).join(", ");
  type Row = Omit<Anexo, "hasText"> & { hasText: number };
  const paraAnexo = (r: Row): Anexo => ({ ...r, hasText: r.hasText === 1 });
  const q = {
    insert: db.prepare("INSERT INTO anexos (id, owner_type, owner_id, name, mime_type, size, has_text, created_at) VALUES (?,?,?,?,?,?,?,?)"),
    um: db.prepare(`SELECT ${cols} FROM anexos WHERE id = ?`),
    doDono: db.prepare(`SELECT ${cols} FROM anexos WHERE owner_type = ? AND owner_id = ? ORDER BY created_at, rowid`),
    indexar: db.prepare("INSERT INTO anexos_fts (texto, anexo_id) VALUES (?, ?)"),
    texto: db.prepare("SELECT texto FROM anexos_fts WHERE anexo_id = ?"),
    busca: db.prepare(
      `SELECT ${colsA}
       FROM anexos_fts f JOIN anexos a ON a.id = f.anexo_id WHERE anexos_fts MATCH ? ORDER BY rank`,
    ),
  };
  return {
    /** Guarda o arquivo e indexa o texto extraído (se houver). */
    salvar(dono: { tipo: DonoAnexo; id: string }, nomeOriginal: string, mimeType: string, dados: Buffer): Anexo {
      const name = sanitizarNome(nomeOriginal);
      const id = randomUUID();
      const texto = extrairTexto(name, dados);
      const anexo: Anexo = {
        id, ownerType: dono.tipo, ownerId: dono.id, name, mimeType, size: dados.length,
        hasText: texto !== null, createdAt: new Date().toISOString(),
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, id), dados);
      try {
        q.insert.run(id, dono.tipo, dono.id, name, mimeType, dados.length, anexo.hasText ? 1 : 0, anexo.createdAt);
        if (texto !== null) q.indexar.run(texto, id);
      } catch (e) {
        rmSync(join(dir, id), { force: true });
        throw e;
      }
      return anexo;
    },
    obter: (id: string): Anexo | undefined => {
      const r = q.um.get(id) as Row | undefined;
      return r && paraAnexo(r);
    },
    listar: (tipo: DonoAnexo, donoId: string): Anexo[] => (q.doDono.all(tipo, donoId) as unknown as Row[]).map(paraAnexo),
    /** Conteúdo do arquivo; ids vêm do banco (UUID gerado), nunca do cliente. */
    ler: (id: string): Buffer => readFileSync(join(dir, id)),
    texto: (id: string): string | undefined => (q.texto.get(id) as { texto: string } | undefined)?.texto,
    /** Busca no texto indexado (todas as palavras). Consulta inválida devolve []. */
    buscar(consulta: string): Anexo[] {
      const palavras = consulta.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (palavras.length === 0) return [];
      const rows = q.busca.all(palavras.map((p) => `"${p}"`).join(" ")) as unknown as Row[];
      return rows.map(paraAnexo);
    },
    close: () => db.close(),
  };
}
export type ArmazemAnexos = ReturnType<typeof abrirAnexos>;
