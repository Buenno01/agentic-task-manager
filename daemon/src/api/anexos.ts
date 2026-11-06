import type { IncomingMessage } from "node:http";
import type { ArmazemAnexos, DonoAnexo } from "../db/anexos.ts";
import { ErroValidacao } from "../domain/tarefa.ts";
import { lerCorpoLimitado } from "./corpo.ts";

export interface RespostaAnexo {
  status: number;
  corpo?: unknown;
  /** Resposta binária (download). */
  arquivo?: { dados: Buffer; tipo: string; nome: string };
}

export const LIMITE_ANEXO_PADRAO = 25 * 1024 * 1024;

/** Tipos servidos como estão no download; qualquer outro vira application/octet-stream. */
const TIPOS_SEGUROS = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain",
]);
export const tipoSeguro = (tipo: string) => (TIPOS_SEGUROS.has(tipo.toLowerCase()) ? tipo.toLowerCase() : "application/octet-stream");

export const dispositionSegura = (nome: string) =>
  `attachment; filename="${nome.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nome)}`;

/**
 * Rotas de anexos (RF13):
 *   POST /tarefas/:id/anexos?nome=x | POST /contextos/:id/anexos?nome=x  (corpo = bytes do arquivo)
 *   GET  /tarefas/:id/anexos | GET /contextos/:id/anexos
 *   GET  /anexos/:id (download) | GET /anexos/:id/texto (texto extraído)
 * Devolve undefined quando a rota não é de anexos.
 */
export function rotaAnexos(
  store: ArmazemAnexos,
  req: IncomingMessage,
  metodo: string,
  path: string,
  query: URLSearchParams,
  donoExiste: (tipo: DonoAnexo, id: string) => boolean,
  maxBytes: number,
): Promise<RespostaAnexo> | RespostaAnexo | undefined {
  const naoEncontrado: RespostaAnexo = { status: 404, corpo: { error: "Não encontrado" } };
  const md = path.match(/^\/(tarefas|contextos)\/([^/]+)\/anexos$/);
  if (md) {
    const tipo: DonoAnexo = md[1] === "tarefas" ? "tarefa" : "contexto";
    if (metodo !== "GET" && metodo !== "POST") return undefined;
    if (!donoExiste(tipo, md[2])) return naoEncontrado;
    if (metodo === "GET") return { status: 200, corpo: store.listar(tipo, md[2]) };
    const nome = (query.get("nome") ?? "").trim();
    if (!nome) throw new ErroValidacao("Informe o nome do arquivo (?nome=)");
    return lerCorpoLimitado(req, maxBytes).then((dados) => {
      if (dados === null) return { status: 413, corpo: { error: `Arquivo excede ${maxBytes} bytes` } };
      const tipoMime = (req.headers["content-type"] ?? "").split(";")[0].trim() || "application/octet-stream";
      return { status: 201, corpo: store.salvar({ tipo, id: md[2] }, nome, tipoMime, dados) };
    });
  }
  const ma = path.match(/^\/anexos\/([^/]+)(\/texto)?$/);
  if (ma && metodo === "GET") {
    const a = store.obter(ma[1]);
    if (!a) return naoEncontrado;
    if (ma[2]) {
      const text = store.texto(a.id);
      return a.hasText ? { status: 200, corpo: { id: a.id, text: text ?? "" } } : naoEncontrado;
    }
    return { status: 200, arquivo: { dados: store.ler(a.id), tipo: a.mimeType, nome: a.name } };
  }
  return undefined;
}
