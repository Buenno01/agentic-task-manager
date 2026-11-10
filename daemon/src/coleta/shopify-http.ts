/** Camada HTTP do cliente Shopify: injetável, para os testes nunca tocarem a rede. */
export interface RequisicaoShopify {
  url: string;
  /** Inclui o token de acesso; nunca registre. */
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface RespostaShopify {
  status: number;
  /** Cabeçalhos em minúsculas. */
  headers: Record<string, string>;
  body: unknown;
}

/** Rejeita com `Error` (name `TimeoutError`) quando estoura `timeoutMs`. */
export type HttpShopify = (req: RequisicaoShopify) => Promise<RespostaShopify>;

/** Implementação real, sobre `fetch`. */
export const httpShopifyReal: HttpShopify = async (req) => {
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs) });
  const texto = await res.text();
  let body: unknown = texto;
  try {
    body = JSON.parse(texto);
  } catch {
    // corpo não-JSON (ex.: página de erro): fica como texto
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
};
