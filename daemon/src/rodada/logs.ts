import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mascarador } from "../seguranca/mascarador.ts";

/** Texto acima disso vai para arquivo em `<logsDir>/<rodada>/`; o evento guarda só caminho e resumo. */
export const LIMITE_EVENTO = 4000;
const TAMANHO_RESUMO = 200;
/** Eventos cujo texto o daemon precisa íntegro no banco (o prompt é do próprio daemon, não saída do agente). */
const SEMPRE_INLINE = new Set(["prompt"]);

export interface RefLog {
  campo: string;
  caminho: string;
  bytes: number;
}

/**
 * Logs por Rodada (ADR-0007): `eventos.log` com todo evento (JSON por linha, já mascarado) e um arquivo por
 * saída grande. Tudo passa pelo Mascarador ANTES de tocar o disco.
 */
export function criarLogs(logsDir: string, mascarador: Mascarador) {
  const dirDe = (rodadaId: string) => join(logsDir, rodadaId);
  let seq = 0;
  let avisou = false;
  return {
    dirDe,
    /** Grava o evento no log da Rodada e devolve o que deve ir para o banco (mascarado, saída grande resumida). */
    processar(rodadaId: string, tipo: string, dados: Record<string, unknown>): Record<string, unknown> {
      const limpo = mascarador.valor(dados);
      const dir = dirDe(rodadaId);
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "eventos.log"), `${JSON.stringify({ em: new Date().toISOString(), tipo, dados: limpo })}\n`);
      } catch (e) {
        // Disco de logs indisponível não derruba a Rodada: o evento segue mascarado e inline no banco.
        if (!avisou) console.error(`Logs indisponíveis em ${logsDir}: ${(e as Error).message}`);
        avisou = true;
        return limpo;
      }
      if (SEMPRE_INLINE.has(tipo)) return limpo;
      const refs: RefLog[] = [];
      const saida: Record<string, unknown> = {};
      for (const [campo, v] of Object.entries(limpo)) {
        if (typeof v === "string" && v.length > LIMITE_EVENTO) {
          const caminho = join(dir, `${String(++seq).padStart(5, "0")}-${tipo.replace(/[^\w.-]/g, "_")}-${campo.replace(/[^\w.-]/g, "_")}.log`);
          try {
            writeFileSync(caminho, v);
          } catch {
            saida[campo] = v;
            continue;
          }
          const bytes = Buffer.byteLength(v);
          refs.push({ campo, caminho, bytes });
          saida[campo] = `${v.slice(0, TAMANHO_RESUMO)}… [${bytes} bytes em ${caminho}]`;
        } else saida[campo] = v;
      }
      return refs.length ? { ...saida, logs: refs } : saida;
    },
  };
}

export type LogsRodada = ReturnType<typeof criarLogs>;
