/**
 * Falhas de Coleta que exigem ação humana (RF24). Cada causa pertence a uma categoria;
 * há no máximo uma Tarefa aberta por (Coletor, categoria). Erros transitórios (5xx, timeout,
 * throttle) NÃO entram aqui: continuam só como Lacuna.
 *
 * Para acrescentar uma causa: ponha a categoria em `CATEGORIAS` e faça o cliente lançar
 * `new ErroExigeAcaoHumana("<categoria>", mensagem)`. Nada mais muda.
 */
export const CATEGORIAS = {
  token: {
    titulo: "token inválido ou expirado",
    orientacao: "Gere um novo token de acesso na loja e atualize a variável de ambiente do Coletor.",
  },
  escopo: {
    titulo: "acesso negado ou escopo faltando",
    orientacao: "Confira se o app da loja tem os escopos de leitura necessários (por exemplo read_orders) e reinstale-o se preciso.",
  },
  loja: {
    titulo: "loja inexistente",
    orientacao: "Confira o domínio da loja (params.shop) no Coletor.",
  },
  analytics: {
    titulo: "analytics indisponível (plano ou escopo)",
    orientacao: "O plano da loja ou os escopos do app não permitem ler sessões e conversão (ShopifyQL). Habilite o escopo read_reports ou o plano necessário; até lá sessões e conversão ficam ausentes.",
  },
  "token-ausente": {
    titulo: "variável de ambiente do token não definida",
    orientacao: "Defina no ambiente do daemon a variável indicada em tokenEnv do Coletor (só o nome fica guardado) e reinicie o daemon.",
  },
} as const;

export type CategoriaFalha = keyof typeof CATEGORIAS;

/** Falha da fonte que só uma pessoa resolve; o cliente da fonte a lança já classificada. */
export class ErroExigeAcaoHumana extends Error {
  categoria: CategoriaFalha;
  constructor(categoria: CategoriaFalha, mensagem: string) {
    super(mensagem);
    this.categoria = categoria;
  }
}

/** Categoria da causa, ou `undefined` quando a falha é transitória ou desconhecida (nunca vira Tarefa). */
export function categoriaDaFalha(e: unknown): CategoriaFalha | undefined {
  return e instanceof ErroExigeAcaoHumana ? e.categoria : undefined;
}

/** Título e descrição da Tarefa. `mensagem` já chega mascarada. */
export function textoDaTarefa(
  categoria: CategoriaFalha,
  info: { source: string; loja?: string; period: string; mensagem: string },
): { title: string; description: string } {
  const c = CATEGORIAS[categoria];
  const onde = info.loja ? ` (${info.loja})` : "";
  return {
    title: `Coleta ${info.source}: ${c.titulo}${onde}`,
    description: [
      `A Coleta falhou e exige ação humana: ${c.titulo}.`,
      `Primeiro período afetado: ${info.period}.`,
      `Erro: ${info.mensagem}`,
      c.orientacao,
      "O período fica como Lacuna e é recuperado na próxima Coleta bem-sucedida. Enquanto esta Tarefa estiver aberta, falhas iguais só registram evento nela.",
    ].join("\n\n"),
  };
}

export interface DepsFalhaHumana {
  armazem: { vincular(coletorId: string, categoria: CategoriaFalha, tarefaId: string, agora: Date): void; ultimaTarefa(coletorId: string, categoria: CategoriaFalha): string | undefined };
  obterTarefa(id: string): { state: string } | undefined;
  criarTarefa(contextId: string, titulo: string, descricao: string): string;
  registrarEvento(tarefaId: string, ev: { autor: string; tipo: string; motivo: string }): void;
}

/** Estados em que a Tarefa já não está aberta: falha igual abre outra. */
const FECHADOS = ["Rejeitado", "Concluído"];
export const AUTOR_COLETOR = "coletor";

/** Cria a Tarefa "Novo" da (Coletor, categoria) ou, havendo uma aberta, só registra o evento nela. */
export function criarRegistroDeFalhaHumana(d: DepsFalhaHumana) {
  return (p: { coletorId: string; contextId: string; source: string; loja?: string; categoria: CategoriaFalha; period: string; mensagem: string; agora: Date }): string => {
    const atual = d.armazem.ultimaTarefa(p.coletorId, p.categoria);
    const t = atual ? d.obterTarefa(atual) : undefined;
    if (atual && t && !FECHADOS.includes(t.state)) {
      d.registrarEvento(atual, { autor: AUTOR_COLETOR, tipo: "falha-repetida", motivo: `${p.period}: ${p.mensagem}` });
      return atual;
    }
    const texto = textoDaTarefa(p.categoria, p);
    const id = d.criarTarefa(p.contextId, texto.title, texto.description);
    d.armazem.vincular(p.coletorId, p.categoria, id, p.agora);
    return id;
  };
}
