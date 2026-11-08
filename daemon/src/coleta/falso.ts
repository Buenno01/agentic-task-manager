import type { ClienteColeta, PedidoColeta, RespostaColeta } from "./cliente.ts";

export interface ClienteFalso extends ClienteColeta {
  /** Define a resposta de um período. */
  definir(period: string, resposta: RespostaColeta): void;
  /** Faz as próximas coletas falharem com `mensagem`. */
  falharCom(mensagem: string): void;
  /** Tokens recebidos, na ordem das chamadas. */
  tokensRecebidos: string[];
  pedidos: PedidoColeta[];
}

const PADRAO: RespostaColeta = { moeda: "BRL", metricas: { orders: 1, netRevenue: 100, averageTicket: 100, conversion: 1 } };

/** Cliente de coleta falso e determinístico, usado nos testes. */
export function criarClienteFalso(): ClienteFalso {
  const respostas = new Map<string, RespostaColeta>();
  let falha: string | undefined;
  const tokensRecebidos: string[] = [];
  const pedidos: PedidoColeta[] = [];
  return {
    tokensRecebidos,
    pedidos,
    definir: (period, resposta) => void respostas.set(period, resposta),
    falharCom: (mensagem) => void (falha = mensagem),
    async coletar(pedido) {
      tokensRecebidos.push(pedido.token);
      pedidos.push(pedido);
      if (falha !== undefined) throw new Error(falha);
      return structuredClone(respostas.get(pedido.period) ?? PADRAO);
    },
  };
}
