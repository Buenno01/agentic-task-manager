import { createHash } from "node:crypto";
import { ErroValidacao } from "./tarefa.ts";
import { agendaDoColetor } from "./agenda.ts";
import { frequenciaDeFechamento } from "./fechamento.ts";

/** Fontes de dados conhecidas. Contrato simples, sem plataforma de plugins (ADR-0003). */
export const FONTES = ["falso", "shopify"] as const;
export type Fonte = (typeof FONTES)[number];

export const FREQUENCIAS = ["diaria", "semanal"] as const;
export type Frequencia = (typeof FREQUENCIAS)[number];

/** Métricas da Coleta (RF25). Ausente no Snapshot fica `null`, nunca zero. */
export const METRICAS = ["orders", "netRevenue", "averageTicket", "conversion"] as const;
export type Metrica = (typeof METRICAS)[number];

/** Métricas extras da Shopify, sem limiar de Anomalia: receita bruta, reembolsos e unidades do dia. */
export const METRICAS_EXTRAS = ["grossRevenue", "refunds", "units"] as const;
/** Quebra por produto: `produto:<id>:unidades` e `produto:<id>:receita`. */
const METRICA_PRODUTO = /^produto:\d+:(unidades|receita)$/;
export const ehMetricaDeSnapshot = (nome: string) => (METRICAS as readonly string[]).includes(nome) || (METRICAS_EXTRAS as readonly string[]).includes(nome) || METRICA_PRODUTO.test(nome);

/** Limiares de variação (%) por métrica. */
export type Limiares = Record<Metrica, number>;
export const LIMIARES_PADRAO: Limiares = { orders: 25, netRevenue: 25, averageTicket: 20, conversion: 30 };

export interface Coletor {
  id: string;
  contextId: string;
  source: Fonte;
  frequency: Frequencia;
  params: Record<string, unknown>;
  recollectWindowDays: number;
  automaticAnalysis: boolean;
  thresholds: Limiares;
  /** Nome da variável de ambiente com o token; o valor nunca é guardado. */
  tokenEnv: string;
  createdAt: string;
}

export type EntradaColetor = Omit<Coletor, "id" | "createdAt">;

/** Só o NOME de uma variável de ambiente (maiúsculas, dígitos e `_`); um valor de token não passa. */
const NOME_VARIAVEL = /^[A-Z_][A-Z0-9_]{0,127}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function validarColetor(e: Record<string, unknown>, contextoExiste: (id: string) => boolean): EntradaColetor {
  if (typeof e.contextId !== "string" || !contextoExiste(e.contextId)) throw new ErroValidacao("Contexto não existe");
  if (!FONTES.includes(e.source as Fonte)) throw new ErroValidacao(`Fonte inválida (use: ${FONTES.join(", ")})`);
  const frequency = e.frequency ?? "diaria";
  if (!FREQUENCIAS.includes(frequency as Frequencia)) throw new ErroValidacao(`Frequência inválida (use: ${FREQUENCIAS.join(", ")})`);
  if (typeof e.tokenEnv !== "string" || !NOME_VARIAVEL.test(e.tokenEnv))
    throw new ErroValidacao("tokenEnv deve ser o nome de uma variável de ambiente (ex.: ATM_LOJA_TOKEN), nunca o valor do token");
  const params = e.params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new ErroValidacao("params deve ser um objeto");
  agendaDoColetor(params as Record<string, unknown>);
  frequenciaDeFechamento(params as Record<string, unknown>);
  if (e.source === "shopify") lojaShopify(params as Record<string, unknown>);
  const janela = e.recollectWindowDays ?? 7;
  if (typeof janela !== "number" || !Number.isInteger(janela) || janela < 1) throw new ErroValidacao("recollectWindowDays deve ser inteiro ≥ 1");
  const auto = e.automaticAnalysis ?? false;
  if (typeof auto !== "boolean") throw new ErroValidacao("automaticAnalysis deve ser booleano");
  const lim = e.thresholds ?? {};
  if (!lim || typeof lim !== "object" || Array.isArray(lim)) throw new ErroValidacao("thresholds deve ser um objeto");
  const thresholds = { ...LIMIARES_PADRAO };
  for (const [k, v] of Object.entries(lim)) {
    if (!METRICAS.includes(k as Metrica)) throw new ErroValidacao(`Limiar de métrica desconhecida: ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ErroValidacao(`Limiar de ${k} deve ser número > 0`);
    thresholds[k as Metrica] = v;
  }
  return {
    contextId: e.contextId,
    source: e.source as Fonte,
    frequency: frequency as Frequencia,
    params: params as Record<string, unknown>,
    recollectWindowDays: janela,
    automaticAnalysis: auto,
    thresholds,
    tokenEnv: e.tokenEnv,
  };
}

const DOMINIO_LOJA = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const VERSAO_API = /^\d{4}-\d{2}$/;
export const VERSAO_API_PADRAO = "2025-01";

/** Loja (`shop`, domínio myshopify.com) e versão da Admin API (`apiVersion`, opcional) dos params de um Coletor Shopify. */
export function lojaShopify(params: Record<string, unknown>): { shop: string; apiVersion: string } {
  if (typeof params.shop !== "string" || !DOMINIO_LOJA.test(params.shop)) throw new ErroValidacao("params.shop deve ser o domínio da loja (ex.: minha-loja.myshopify.com)");
  const apiVersion = params.apiVersion ?? VERSAO_API_PADRAO;
  if (typeof apiVersion !== "string" || !VERSAO_API.test(apiVersion)) throw new ErroValidacao("params.apiVersion deve ser AAAA-MM (ex.: 2025-01)");
  return { shop: params.shop, apiVersion };
}

/** Período pedido (AAAA-MM-DD) ou, por padrão, o dia anterior ao relógio. */
export function periodoDaColeta(pedido: unknown, agoraMs: number): string {
  if (pedido === undefined || pedido === null) return new Date(agoraMs - 86_400_000).toISOString().slice(0, 10);
  if (typeof pedido !== "string" || !DATA.test(pedido) || Number.isNaN(Date.parse(pedido))) throw new ErroValidacao("period deve ser AAAA-MM-DD");
  return pedido;
}

/** Métricas conhecidas, em ordem estável; ausente vira null. */
export function normalizarMetricas(bruto: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of Object.keys(bruto).filter(ehMetricaDeSnapshot).sort()) {
    const v = bruto[m];
    if (v !== undefined && v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`Métrica ${m} inválida na resposta da fonte`);
    if (v !== undefined) out[m] = v;
  }
  return out;
}

/** sha256 de {"period","currency","payload"} em JSON compacto (payload com chaves ordenadas). */
export function hashDoSnapshot(period: string, currency: string, payload: Record<string, number | null>): string {
  const ordenado = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash("sha256").update(JSON.stringify({ period, currency, payload: ordenado })).digest("hex");
}
