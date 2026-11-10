import type { Credenciais } from "../auth/credenciais.ts";

/**
 * Mascarador de segredos (ADR-0001, ADR-0007): troca por `[mascarado]` qualquer valor secreto conhecido
 * antes de gravar evento, log ou histórico. Cobre tokens humano e de agentes, token do GitHub e chaves
 * de provedor do ambiente (variáveis *_API_KEY, *_TOKEN, *_SECRET, *_PASSWORD...). A lista é lida a cada
 * chamada, então segredos que entram no ambiente depois do boot também são cobertos.
 */
export const MASCARA = "[mascarado]";

/** Segredos muito curtos gerariam falsos positivos (ex.: "1"); abaixo disso não mascaramos. */
const TAMANHO_MINIMO = 8;
const NOME_SECRETO = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)/i;
/** Variáveis de ambiente que casam o padrão mas não guardam segredo. */
const NAO_SEGREDO = /^(ATM_MAX_RODADAS|ATM_PORT)$/;

export type FonteSegredos = () => Iterable<string | undefined | null>;

export interface Mascarador {
  /** Mascara um texto. */
  texto(s: string): string;
  /** Mascara recursivamente todas as strings (chaves inclusive) de um valor JSON. */
  valor<T>(v: T): T;
}

/** Valores secretos das variáveis de ambiente (nome sugere segredo) e do `.env` já carregado em process.env. */
export function segredosDoAmbiente(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => !!v && NOME_SECRETO.test(k) && !NAO_SEGREDO.test(k))
    .flatMap(([k, v]) => {
      const valor = v as string;
      // ATM_AGENT_TOKENS é "id:token,id2:token2": cada token, além do valor inteiro.
      return k === "ATM_AGENT_TOKENS" ? [valor, ...valor.split(",").map((p) => p.slice(p.indexOf(":") + 1))] : [valor];
    });
}

export function segredosDasCredenciais(c: Credenciais): string[] {
  return [c.humano, ...Object.values(c.agentes)];
}

export function criarMascarador(...fontes: FonteSegredos[]): Mascarador {
  const lista = (): string[] => {
    const set = new Set<string>();
    for (const f of fontes)
      for (const s of f()) {
        const v = s?.trim();
        if (!v || v.length < TAMANHO_MINIMO) continue;
        set.add(v);
        // Forma escapada em JSON (aspas, barras), que aparece ao serializar eventos.
        const j = JSON.stringify(v).slice(1, -1);
        if (j !== v) set.add(j);
        set.add(encodeURIComponent(v));
        set.add(Buffer.from(v).toString("base64"));
      }
    // Mais longos primeiro: um segredo que contém outro é mascarado inteiro.
    return [...set].sort((a, b) => b.length - a.length);
  };
  const texto = (s: string): string => {
    let out = s;
    for (const seg of lista()) if (out.includes(seg)) out = out.split(seg).join(MASCARA);
    return out;
  };
  const valor = <T>(v: T): T => {
    if (typeof v === "string") return texto(v) as T;
    if (Array.isArray(v)) return v.map((x) => valor(x)) as T;
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [texto(k), valor(x)])) as T;
    return v;
  };
  return { texto, valor };
}
