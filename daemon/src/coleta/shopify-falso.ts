import type { HttpShopify, RequisicaoShopify, RespostaShopify } from "./shopify-http.ts";

export interface LinhaFalsa {
  productId: number;
  quantity: number;
  total: number;
}

export interface PedidoFalso {
  /** Instante UTC de criação. */
  createdAt: string;
  total: number;
  refunded?: number;
  linhas?: LinhaFalsa[];
}

export type Cena = RespostaShopify | { erro: "timeout" | "rede" };

export interface ShopifyFalso {
  http: HttpShopify;
  /** Pedidos da loja (a ordem é a da paginação). */
  pedidos: PedidoFalso[];
  moeda: string;
  /** Cenas consumidas antes das respostas normais (uma por requisição). */
  cenas: Cena[];
  /** Quantos pedidos por página. */
  porPagina: number;
  /** Custo reportado em `extensions.cost`. */
  custo: { requestedQueryCost: number; currentlyAvailable: number; restoreRate: number };
  requisicoes: RequisicaoShopify[];
  /** Sessões e taxa de conversão (fração) por dia civil; dia ausente = ShopifyQL sem linhas. */
  analytics: Record<string, { sessions: number; conversionRate: number }>;
  /** Cenas consumidas só pelas consultas ShopifyQL (as de pedidos usam `cenas`). */
  cenasAnalytics: Cena[];
  /** A loja não tem acesso a analytics (plano ou escopo): ACCESS_DENIED. */
  analyticsSemAcesso: boolean;
  /** Consultas ShopifyQL recebidas (ficam fora de `requisicoes`). */
  requisicoesAnalytics: RequisicaoShopify[];
}

const dinheiro = (n: number, moeda: string) => ({ shopMoney: { amount: n.toFixed(2), currencyCode: moeda } });

/** Loja Shopify falsa: interpreta a janela `created_at` da consulta e responde como a Admin API GraphQL. */
export function criarShopifyFalso(): ShopifyFalso {
  const f: ShopifyFalso = {
    pedidos: [],
    moeda: "BRL",
    cenas: [],
    porPagina: 100,
    custo: { requestedQueryCost: 10, currentlyAvailable: 1000, restoreRate: 50 },
    requisicoes: [],
    analytics: {},
    cenasAnalytics: [],
    analyticsSemAcesso: false,
    requisicoesAnalytics: [],
    http: async (req) => {
      const analytics = req.body.includes("shopifyqlQuery");
      (analytics ? f.requisicoesAnalytics : f.requisicoes).push(req);
      const cena = (analytics ? f.cenasAnalytics : f.cenas).shift();
      if (cena) {
        if ("erro" in cena) {
          const e = new Error(cena.erro === "timeout" ? "The operation was aborted due to timeout" : "fetch failed");
          e.name = cena.erro === "timeout" ? "TimeoutError" : "TypeError";
          throw e;
        }
        return cena;
      }
      if (analytics) {
        if (f.analyticsSemAcesso)
          return {
            status: 200,
            headers: {},
            body: { errors: [{ message: "Access denied for shopifyqlQuery field.", extensions: { code: "ACCESS_DENIED" } }] },
          };
        const { variables: v } = JSON.parse(req.body) as { variables: { shopifyql: string } };
        const dia = /SINCE (\d{4}-\d{2}-\d{2})/.exec(v.shopifyql)![1];
        const linha = f.analytics[dia];
        const rows = linha ? [{ day: dia, sessions: String(linha.sessions), conversion_rate: String(linha.conversionRate) }] : [];
        return {
          status: 200,
          headers: {},
          body: { data: { shopifyqlQuery: { parseErrors: [], tableData: { columns: [{ name: "day" }, { name: "sessions" }, { name: "conversion_rate" }], rows } } } },
        };
      }
      const { variables } = JSON.parse(req.body) as { variables: { query: string; after: string | null } };
      const [, de, ate] = /created_at:>=(\S+) created_at:<(\S+)/.exec(variables.query)!;
      const doDia = f.pedidos.filter((p) => Date.parse(p.createdAt) >= Date.parse(de) && Date.parse(p.createdAt) < Date.parse(ate));
      const inicio = variables.after ? Number(variables.after) : 0;
      const pagina = doDia.slice(inicio, inicio + f.porPagina);
      const proximo = inicio + f.porPagina;
      return {
        status: 200,
        headers: {},
        body: {
          data: {
            shop: { currencyCode: f.moeda },
            orders: {
              pageInfo: { hasNextPage: proximo < doDia.length, endCursor: String(proximo) },
              edges: pagina.map((p, i) => ({
                node: {
                  id: `gid://shopify/Order/${inicio + i + 1}`,
                  createdAt: p.createdAt,
                  totalPriceSet: dinheiro(p.total, f.moeda),
                  totalRefundedSet: dinheiro(p.refunded ?? 0, f.moeda),
                  lineItems: {
                    edges: (p.linhas ?? []).map((l) => ({
                      node: {
                        quantity: l.quantity,
                        discountedTotalSet: dinheiro(l.total, f.moeda),
                        product: { id: `gid://shopify/Product/${l.productId}` },
                      },
                    })),
                  },
                },
              })),
            },
          },
          extensions: { cost: { requestedQueryCost: f.custo.requestedQueryCost, throttleStatus: { currentlyAvailable: f.custo.currentlyAvailable, restoreRate: f.custo.restoreRate } } },
        },
      };
    },
  };
  return f;
}
