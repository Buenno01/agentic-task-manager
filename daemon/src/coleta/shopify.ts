import type { ClienteColeta, PedidoColeta, RespostaColeta } from "./cliente.ts";
import { httpShopifyReal, type HttpShopify, type RespostaShopify } from "./shopify-http.ts";
import { agendaDoColetor, dataNoFuso, somarDias } from "../domain/agenda.ts";
import { chaveDeProduto, lojaShopify } from "../domain/coleta.ts";
import { coletarAnalytics, ErroAcessoNegado } from "./shopifyql.ts";
import { ErroExigeAcaoHumana } from "./falha-humana.ts";

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
  /** Relógio (ms) para interpretar Retry-After em data HTTP; testes injetam. */
  agora?: () => number;
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

/** Erro de falha que não adianta retentar (consulta inválida, resposta inesperada). */
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

/** Teto de qualquer espera vinda do servidor (Retry-After, custo GraphQL): nunca bloqueia a Coleta além disso. */
export const ESPERA_MAXIMA_MS = 60_000;
const limitar = (ms: number) => Math.min(ms, ESPERA_MAXIMA_MS);

/** Retry-After em segundos ou em data HTTP; `undefined` se ausente ou inválido. */
export function esperaDoRetryAfter(valor: string | undefined, agoraMs: number): number | undefined {
  if (valor === undefined || valor.trim() === "") return undefined;
  const s = Number(valor);
  if (Number.isFinite(s)) return s >= 0 ? s * 1000 : undefined;
  const data = Date.parse(valor);
  return Number.isNaN(data) ? undefined : Math.max(0, data - agoraMs);
}

/** Corpo bruto da resposta com erro, para depuração (limitado; o mascaramento é de quem grava). */
const brutoDe = (corpo: unknown) => (typeof corpo === "string" ? corpo : JSON.stringify(corpo ?? null)).slice(0, 20_000);

/** Coletor Shopify real (Admin API GraphQL, somente leitura): pedidos, receita e produtos do dia civil da loja. */
export function criarClienteShopify(opts: OpcoesShopify = {}): ClienteColeta {
  const http = opts.http ?? httpShopifyReal;
  const dormir = opts.dormir ?? dormirDeVerdade;
  const tentativas = opts.tentativas ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const porPagina = opts.porPagina ?? 100;
  const agora = opts.agora ?? Date.now;

  /** Uma requisição com retentativa: 429/5xx esperam o Retry-After (ou o backoff); timeout e THROTTLED, o backoff ou o custo. */
  async function consultar(pedido: PedidoColeta, url: string, texto: string, variables: Record<string, unknown>) {
    let ultimo = new Error("falha desconhecida");
    for (let n = 1; n <= tentativas; n++) {
      let bruto: string | undefined;
      try {
        let res: RespostaShopify;
        try {
          res = await http({
            url,
            headers: { "content-type": "application/json", "x-shopify-access-token": pedido.token },
            body: JSON.stringify({ query: texto, variables }),
            timeoutMs,
          });
        } catch (e) {
          const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
          throw new ErroTransitorio(timeout ? `Shopify: timeout após ${timeoutMs} ms` : "Shopify: falha de rede");
        }
        if (res.status !== 200) bruto = brutoDe(res.body);
        if (res.status === 401) throw new ErroExigeAcaoHumana("token", "Shopify recusou a credencial (HTTP 401): token inválido ou expirado");
        if (res.status === 403) throw new ErroExigeAcaoHumana("escopo", "Shopify negou o acesso (HTTP 403): token sem escopo ou sem permissão");
        if (res.status === 404) throw new ErroExigeAcaoHumana("loja", "Shopify não encontrou a loja (HTTP 404)");
        const retryAfter = esperaDoRetryAfter(res.headers["retry-after"], agora());
        if (res.status === 429) throw new ErroTransitorio("Shopify: limite de requisições (HTTP 429)", retryAfter);
        if (res.status >= 500) throw new ErroTransitorio(`Shopify indisponível (HTTP ${res.status})`, retryAfter);
        if (res.status !== 200) throw new ErroFatal(`Shopify respondeu HTTP ${res.status}`);
        const corpo = res.body as { data?: any; errors?: Array<{ message?: string; extensions?: { code?: string } }>; extensions?: { cost?: Custo } };
        if (corpo.errors?.length) {
          bruto = brutoDe(res.body);
          if (corpo.errors.some((e) => e.extensions?.code === "THROTTLED"))
            throw new ErroTransitorio("Shopify: custo GraphQL excedido (THROTTLED)", esperaPeloCusto(corpo.extensions?.cost) || undefined);
          if (corpo.errors.some((e) => e.extensions?.code === "ACCESS_DENIED"))
            throw new ErroExigeAcaoHumana("escopo", `Shopify GraphQL: acesso negado (${corpo.errors.map((e) => e.message ?? "erro").join("; ")})`);
          throw new ErroFatal(`Shopify GraphQL: ${corpo.errors.map((e) => e.message ?? "erro").join("; ")}`);
        }
        return { data: corpo.data, custo: corpo.extensions?.cost };
      } catch (e) {
        if (e instanceof Error && bruto !== undefined) (e as Error & { respostaBruta?: string }).respostaBruta = bruto;
        if (e instanceof ErroFatal || e instanceof ErroExigeAcaoHumana || !(e instanceof ErroTransitorio)) throw e;
        ultimo = e;
        if (n < tentativas) await dormir(limitar(e.esperaMs ?? backoffMs * 2 ** (n - 1)));
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
        const { data, custo } = await consultar(pedido, url, CONSULTA, { query, first: porPagina, after });
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
        if (espera) await dormir(limitar(espera));
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
        metricas[chaveDeProduto(id, "unidades")] = p.unidades;
        metricas[chaveDeProduto(id, "receita")] = arredondar(p.receita);
      }
      // Sessões e conversão (ShopifyQL, módulo isolado): se faltarem, ficam null (nunca zero) e a Coleta é parcial.
      const analytics = await coletarAnalytics(async (texto, variaveis) => {
        try {
          return await consultar(pedido, url, texto, variaveis);
        } catch (e) {
          throw e instanceof ErroExigeAcaoHumana && e.categoria === "escopo" ? new ErroAcessoNegado(e.message) : e;
        }
      }, pedido.period);
      metricas.sessions = analytics.sessions;
      metricas.conversion = analytics.conversion;
      return { moeda, metricas, ...(analytics.parcial ? { parcial: analytics.parcial } : {}) };
    },
  };
}
