import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

/** Tokens vêm de ATM_HUMAN_TOKEN e ATM_AGENT_TOKENS ("id:token,id2:token2") (ADR-0001, ADR-0007). */
export interface Credenciais {
  humano: string;
  agentes: Record<string, string>;
}

/** Autor de uma ação: "humano" ou "agente:<id>". */
export type Autor = { tipo: "humano" } | { tipo: "agente"; id: string };

export const rotuloAutor = (a: Autor) => (a.tipo === "humano" ? "humano" : `agente:${a.id}`);

function lerDotenv(caminho: string): Record<string, string> {
  if (!existsSync(caminho)) return {};
  const out: Record<string, string> = {};
  for (const linha of readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || linha.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Tokens de exemplo ou fracos nunca valem (cópia crua do .env.example). */
const TOKEN_MIN = 16;
function validarToken(nome: string, valor: string) {
  if (valor.startsWith("troque-por"))
    throw new Error(`${nome} ainda é o valor de exemplo (troque-por…); gere um token longo e aleatório.`);
  if (valor.length < TOKEN_MIN) throw new Error(`${nome} é curto demais: use ao menos ${TOKEN_MIN} caracteres.`);
}

/** Variáveis de ambiente têm precedência sobre o `.env` (fallback só para desenvolvimento local). Sem token humano, devolve undefined. */
export function carregarCredenciais(
  env: Record<string, string | undefined> = process.env,
  arquivoEnv = ".env",
): Credenciais | undefined {
  const fonte = { ...lerDotenv(arquivoEnv), ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)) };
  const humano = fonte.ATM_HUMAN_TOKEN;
  if (!humano) return undefined;
  validarToken("ATM_HUMAN_TOKEN", humano);
  const agentes: Record<string, string> = {};
  for (const par of (fonte.ATM_AGENT_TOKENS ?? "").split(",")) {
    const i = par.indexOf(":");
    if (i > 0 && i < par.length - 1) {
      const id = par.slice(0, i).trim();
      const token = par.slice(i + 1).trim();
      validarToken(`ATM_AGENT_TOKENS (agente "${id}")`, token);
      agentes[id] = token;
    }
  }
  return { humano, agentes };
}

const igual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Identifica o autor pelo cabeçalho Authorization: Bearer; undefined se o token não vale. */
export function autenticar(cred: Credenciais, authorization: string | undefined): Autor | undefined {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return undefined;
  if (igual(token, cred.humano)) return { tipo: "humano" };
  for (const [id, t] of Object.entries(cred.agentes)) if (igual(token, t)) return { tipo: "agente", id };
  return undefined;
}

/** Guarda reutilizável: toda rota de aprovação passa por aqui; agentes são recusados. */
export const apenasHumano = (a: Autor) => a.tipo === "humano";
