import type { Fonte } from "../domain/coleta.ts";
import type { Parcial } from "./shopifyql.ts";

export interface PedidoColeta {
  source: Fonte;
  params: Record<string, unknown>;
  /** AAAA-MM-DD */
  period: string;
  /** Valor lido da variável de ambiente do Coletor; vive só em memória. */
  token: string;
}

export interface RespostaColeta {
  /** Moeda da loja (ISO 4217). */
  moeda: string;
  metricas: Record<string, number | null>;
  /** Presente quando a Coleta veio incompleta (ex.: ShopifyQL falhou); `metricas` traz `null` nas ausentes. */
  parcial?: Parcial;
}

/** Cliente da fonte (injetável em `startDaemon`; testes usam o falso). */
export interface ClienteColeta {
  coletar(pedido: PedidoColeta): Promise<RespostaColeta>;
}

/** Despacha a Coleta ao cliente da fonte: Shopify vai ao cliente Shopify; o resto, ao `outro`. */
export function clientePorFonte(outro: ClienteColeta, shopify: ClienteColeta): ClienteColeta {
  return { coletar: (pedido) => (pedido.source === "shopify" ? shopify : outro).coletar(pedido) };
}

/** Padrão quando nada foi injetado: nenhuma fonte real configurada ainda. */
export const clienteNaoConfigurado: ClienteColeta = {
  async coletar() {
    throw new Error("Nenhum cliente de coleta configurado");
  },
};
