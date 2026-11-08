import type { ClienteColeta, PedidoColeta, RespostaColeta } from "./cliente.ts";
import { httpShopifyReal, type HttpShopify, type RespostaShopify } from "./shopify-http.ts";
import { agendaDoColetor, dataNoFuso, somarDias } from "../domain/agenda.ts";
import { lojaShopify } from "../domain/coleta.ts";

export interface OpcoesShopify {
  /** Camada HTTP; testes injetam a loja falsa. */
  http?: HttpShopify;
  /** Espera entre tentativas; testes injetam um registrador sem espera real. */
  dormir?: (ms: number) => Promise<void>;
  /** Total de tentativas por requisição (padrão 3). */
  tentativas?: number;
  /** Espera base do backoff exponencial em ms (padrão 1000: 1 s, 2 s, 4 s...). */
  backoffMs?: number;
  timeoutMs?: number;
  /** Pedidos por página (padrão 100). */
  porPagina?: number;
}

const CONSULTA = `query Pedidos($query: String!, $first: Int!, $after: String) {
  shop { currencyCode }
  orders(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) { edges { node {
        quantity
        discountedTotalSet { shopMoney { amount } }
        product { id }
      } } }
    } }
  }
}`;

/** Erro de falha que não adianta retentar (credencial recusada, consulta inválida). */
class ErroFatal extends Error {}
/** Erro transitório; `esperaMs` vem do Retry-After ou do custo, quando a Shopify informou. */
class ErroTransitorio extends Error {
  esperaMs: number | undefined;
  constructor(mensagem: string, esperaMs?: number) {
    super(mensagem);
    this.esperaMs = esperaMs;
  }
}

const arredondar = (n: number) => Math.round(n * 100) / 100;

/** Primeiro instante (ms UTC) do dia civil `periodo` no fuso `timezone`. */
export function inicioDoDia(periodo: string, timezone: string): number {
  const alvo = Date.parse(`${periodo}T00:00:00Z`);
  let ms = alvo;
  for (let i = 0; i < 3; i++) {
    const { data, minutos } = dataNoFuso(ms, timezone);
    ms += alvo - (Date.parse(`${data}T00:00:00Z`) + minutos * 60_000);
  }
  return ms;
}

interface Custo {
  requestedQueryCost?: number;
  throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
}

/** Segundos de espera para o balde de custo comportar a próxima consulta; 0 se já comporta. */
function esperaPeloCusto(custo: Custo | undefined): number {
  const pedido = custo?.requestedQueryCost;
  const disponivel = custo?.throttleStatus?.currentlyAvailable;
  const taxa = custo?.throttleStatus?.restoreRate;
  if (pedido === undefined || disponivel === undefined || !taxa || pedido <= disponivel) return 0;
  return Math.ceil((pedido - disponivel) / taxa) * 1000;
}

const dormirDeVerdade = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Coletor Shopify real (Admin API GraphQL, somente leitura): pedidos, receita e produtos do dia civil da loja. */
export function criarClienteShopify(opts: OpcoesShopify = {}): ClienteColeta {
  const http = opts.http ?? httpShopifyReal;
  const dormir = opts.dormir ?? dormirDeVerdade;
  const tentativas = opts.tentativas ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const porPagina = opts.porPagina ?? 100;

  /** Uma requisição com retentativa: 429 espera o Retry-After; 5xx, timeout e THROTTLED, o backoff ou o custo. */
  async function consultar(pedido: PedidoColeta, url: string, variables: Record<string, unknown>) {
    let ultimo = new Error("falha desconhecida");
    for (let n = 1; n <= tentativas; n++) {
      try {
        let res: RespostaShopify;
        try {
          res = await http({
            url,
            headers: { "content-type": "application/json", "x-shopify-access-token": pedido.token },
            body: JSON.stringify({ query: CONSULTA, variables }),
            timeoutMs,
          });
        } catch (e) {
          const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
          throw new ErroTransitorio(timeout ? `Shopify: timeout após ${timeoutMs} ms` : "Shopify: falha de rede");
        }
        if (res.status === 401 || res.status === 403)
          throw new ErroFatal(`Shopify recusou a credencial (HTTP ${res.status}): token inválido, expirado ou sem escopo`);
        if (res.status === 429) {
          const s = Number(res.headers["retry-after"]);
          throw new ErroTransitorio("Shopify: limite de requisições (HTTP 429)", Number.isFinite(s) && s >= 0 ? s * 1000 : undefined);
        }
        if (res.status >= 500) throw new ErroTransitorio(`Shopify indisponível (HTTP ${res.status})`);
        if (res.status !== 200) throw new ErroFatal(`Shopify respondeu HTTP ${res.status}`);
        const corpo = res.body as { data?: any; errors?: Array<{ message?: string; extensions?: { code?: string } }>; extensions?: { cost?: Custo } };
        if (corpo.errors?.length) {
          if (corpo.errors.some((e) => e.extensions?.code === "THROTTLED"))
            throw new ErroTransitorio("Shopify: custo GraphQL excedido (THROTTLED)", esperaPeloCusto(corpo.extensions?.cost) || undefined);
          throw new ErroFatal(`Shopify GraphQL: ${corpo.errors.map((e) => e.message ?? "erro").join("; ")}`);
        }
        return { data: corpo.data, custo: corpo.extensions?.cost };
      } catch (e) {
        if (e instanceof ErroFatal || !(e instanceof ErroTransitorio)) throw e;
        ultimo = e;
        if (n < tentativas) await dormir(e.esperaMs ?? backoffMs * 2 ** (n - 1));
      }
    }
    throw ultimo;
  }

  return {
    async coletar(pedido): Promise<RespostaColeta> {
      const { shop, apiVersion } = lojaShopify(pedido.params);
      const { timezone } = agendaDoColetor(pedido.params);
      const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
      const de = new Date(inicioDoDia(pedido.period, timezone)).toISOString();
      const ate = new Date(inicioDoDia(somarDias(pedido.period, 1), timezone)).toISOString();
      const query = `created_at:>=${de} created_at:<${ate}`;

      let moeda = "";
      let pedidos = 0;
      let bruta = 0;
      let reembolsos = 0;
      let unidades = 0;
      const porProduto = new Map<string, { unidades: number; receita: number }>();
      let after: string | null = null;
      for (;;) {
        const { data, custo } = await consultar(pedido, url, { query, first: porPagina, after });
        moeda = data.shop.currencyCode;
        for (const { node } of data.orders.edges) {
          pedidos++;
          bruta += Number(node.totalPriceSet.shopMoney.amount);
          reembolsos += Number(node.totalRefundedSet.shopMoney.amount);
          for (const { node: l } of node.lineItems.edges) {
            unidades += l.quantity;
            const id = l.product?.id?.split("/").pop();
            if (!id) continue; // item avulso, sem produto
            const acc = porProduto.get(id) ?? { unidades: 0, receita: 0 };
            acc.unidades += l.quantity;
            acc.receita += Number(l.discountedTotalSet.shopMoney.amount);
            porProduto.set(id, acc);
          }
        }
        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
        const espera = esperaPeloCusto(custo);
        if (espera) await dormir(espera);
      }

      const liquida = arredondar(bruta - reembolsos);
      const metricas: Record<string, number | null> = {
        orders: pedidos,
        grossRevenue: arredondar(bruta),
        refunds: arredondar(reembolsos),
        netRevenue: liquida,
        units: unidades,
      };
      if (pedidos > 0) metricas.averageTicket = arredondar(liquida / pedidos);
      for (const [id, p] of porProduto) {
        metricas[`produto:${id}:unidades`] = p.unidades;
        metricas[`produto:${id}:receita`] = arredondar(p.receita);
      }
      return { moeda, metricas };
    },
  };
}
