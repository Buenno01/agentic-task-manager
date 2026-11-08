/**
 * Sessões e taxa de conversão via ShopifyQL (`shopifyqlQuery`, escopo `read_analytics`).
 * Módulo isolado porque é a parte mais frágil da Coleta: quando falha, a Coleta segue parcial
 * (as métricas ficam ausentes, nunca zero) e o período entra como Lacuna parcial.
 */

/** Por que o período ficou parcial: `analytics-indisponivel` exige ação humana (plano/escopo); `analytics-falhou` é falha da consulta. */
export type CausaParcial = "analytics-indisponivel" | "analytics-falhou";

export interface Parcial {
  causa: CausaParcial;
  /** Métricas que não vieram, em ordem estável. */
  faltando: string[];
  /** Texto do erro (ainda sem máscara; o armazém mascara). */
  erro: string;
}

export interface Analytics {
  sessions: number | null;
  conversion: number | null;
  parcial?: Parcial;
}

/** A loja não tem acesso a analytics (plano sem relatórios ou token sem `read_analytics`). */
export class ErroAcessoNegado extends Error {}

/** Executa uma consulta GraphQL (já com retentativas) e devolve `data`. */
export type ExecutorGraphQL = (consulta: string, variaveis: Record<string, unknown>) => Promise<{ data: any }>;

export const CONSULTA_SHOPIFYQL = `query Analytics($shopifyql: String!) {
  shopifyqlQuery(query: $shopifyql) {
    parseErrors
    tableData { columns { name } rows }
  }
}`;

const METRICAS_ANALYTICS = ["conversion", "sessions"];

/** ShopifyQL de um dia civil da loja (o fuso é o da loja, aplicado pela Shopify). */
export const shopifyqlDoDia = (periodo: string) =>
  `FROM sessions SHOW sessions, conversion_rate GROUP BY day SINCE ${periodo} UNTIL ${periodo}`;

const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Nunca lança: qualquer falha vira `parcial` com as duas métricas ausentes. */
export async function coletarAnalytics(executar: ExecutorGraphQL, periodo: string): Promise<Analytics> {
  const parcial = (causa: CausaParcial, erro: string): Analytics => ({ sessions: null, conversion: null, parcial: { causa, faltando: METRICAS_ANALYTICS, erro } });
  try {
    const { data } = await executar(CONSULTA_SHOPIFYQL, { shopifyql: shopifyqlDoDia(periodo) });
    const r = data?.shopifyqlQuery;
    if (r?.parseErrors?.length) return parcial("analytics-falhou", `ShopifyQL: ${[].concat(r.parseErrors).join("; ")}`);
    const linhas = r?.tableData?.rows;
    if (!Array.isArray(linhas) || linhas.length === 0) return parcial("analytics-falhou", `ShopifyQL não devolveu linhas para ${periodo}`);
    const sessions = numero(linhas[0].sessions);
    const conversion = numero(linhas[0].conversion_rate);
    const faltando = [...(conversion === null ? ["conversion"] : []), ...(sessions === null ? ["sessions"] : [])];
    return faltando.length ? { sessions, conversion, parcial: { causa: "analytics-falhou", faltando, erro: `ShopifyQL sem valor para: ${faltando.join(", ")}` } } : { sessions, conversion };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return parcial(e instanceof ErroAcessoNegado ? "analytics-indisponivel" : "analytics-falhou", msg);
  }
}
