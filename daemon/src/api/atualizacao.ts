import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Resposta } from "./contextos.ts";

/** Nomes no diretório `run` compartilhado com o host (ADR-0005: a API só sinaliza, nunca executa). */
export const ARQUIVO_MARCADOR = "configurada"; // gravado pelo instalador do host 
export const ARQUIVO_PEDIDO = "pedido-atualizacao"; // gravado só por esta API; a unit .path do host o consome
export const ARQUIVO_ULTIMA = "ultima-atualizacao.json"; // gravado por scripts/atualizar.sh

export interface DepsAtualizacao {
  /** Diretório `run` (ATM_RUN_DIR). Ausente ou inexistente => atualização indisponível. */
  runDir?: string;
  /** Tag em execução (ATM_VERSAO, exportada pelo script). */
  versao?: string;
}

function lerUltima(runDir: string | undefined): unknown {
  if (!runDir) return null;
  try {
    const v = JSON.parse(readFileSync(join(runDir, ARQUIVO_ULTIMA), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** GET /atualizacao e POST /atualizacao/pedido, ambos só do humano (`negado` = o 403 compartilhado do servidor). Devolve undefined se a rota não for daqui. */
export function rotaAtualizacao(d: DepsAtualizacao, metodo: string, path: string, humano: boolean, negado: Resposta): Resposta | undefined {
  const consulta = path === "/atualizacao" && metodo === "GET";
  const pedido = path === "/atualizacao/pedido" && metodo === "POST";
  if (!consulta && !pedido) return undefined;
  if (!humano) return negado;

  const configurada = !!d.runDir && existsSync(join(d.runDir, ARQUIVO_MARCADOR));
  const pendente = () => !!d.runDir && existsSync(join(d.runDir, ARQUIVO_PEDIDO));

  if (consulta) {
    return {
      status: 200,
      corpo: {
        versao: d.versao || null,
        configurada,
        estado: configurada ? "disponivel" : "indisponivel",
        pedidoPendente: configurada && pendente(),
        ultima: lerUltima(d.runDir),
      },
    };
  }

  if (!configurada || !d.runDir)
    return { status: 409, corpo: { error: "A atualização não está configurada neste host (marcador ausente no diretório run); nada foi pedido" } };
  if (pendente()) return { status: 202, corpo: { aceito: true, jaPendente: true } };
  // Temporário + link: o arquivo de pedido aparece completo e atomicamente, e uma corrida não o sobrescreve.
  const tmp = join(d.runDir, `.pedido.${process.pid}.${Date.now()}`);
  try {
    writeFileSync(tmp, JSON.stringify({ pedidoEm: new Date().toISOString(), por: "humano" }) + "\n");
    try {
      linkSync(tmp, join(d.runDir, ARQUIVO_PEDIDO));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return { status: 202, corpo: { aceito: true, jaPendente: true } };
      throw e;
    }
  } catch {
    return { status: 500, corpo: { error: "Não consegui gravar o pedido no diretório run (permissão?)" } };
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  return { status: 202, corpo: { aceito: true, jaPendente: false } };
}
