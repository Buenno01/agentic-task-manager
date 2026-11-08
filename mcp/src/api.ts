/** Cliente HTTP fino da API do daemon. Não tem regra de negócio: repassa chamadas e erros. */
export class ErroApi extends Error {
  status: number;
  constructor(status: number, corpo: string) {
    super(`API ${status}: ${corpo}`);
    this.status = status;
  }
}

export interface OpcoesApi {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export function criarApi({ apiUrl, token, fetch: f = fetch }: OpcoesApi) {
  const base = apiUrl.replace(/\/+$/, "");
  async function chamar(metodo: string, caminho: string, corpo?: unknown): Promise<unknown> {
    const r = await f(base + caminho, {
      method: metodo,
      headers: { authorization: `Bearer ${token}`, ...(corpo === undefined ? {} : { "content-type": "application/json" }) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    if (!r.ok) throw new ErroApi(r.status, texto);
    return texto ? JSON.parse(texto) : null;
  }
  const seg = encodeURIComponent;
  return {
    contextoResolvido: (id: string) => chamar("GET", `/contextos/${seg(id)}/resolvido`),
    consolidado: (id: string) => chamar("GET", `/contextos/${seg(id)}/consolidado`),
    buscar: (q: string, contextoId?: string, subarvore?: boolean) => {
      const p = new URLSearchParams({ q });
      if (contextoId) p.set("contexto", contextoId);
      if (subarvore) p.set("subarvore", "1");
      return chamar("GET", `/busca?${p}`);
    },
    comentar: (tarefaId: string, corpo: { tipo?: string; texto: string; respondeA?: string }) =>
      chamar("POST", `/tarefas/${seg(tarefaId)}/comentarios`, corpo),
    criarTarefa: (corpo: Record<string, unknown>) => chamar("POST", "/tarefas", corpo),
    tarefa: (id: string) => chamar("GET", `/tarefas/${seg(id)}`),
    eventos: (id: string) => chamar("GET", `/tarefas/${seg(id)}/eventos`),
    checkpoint: (id: string, corpo: Record<string, unknown>) => chamar("POST", `/tarefas/${seg(id)}/checkpoint`, corpo),
    perguntar: (id: string, texto: string) => chamar("POST", `/tarefas/${seg(id)}/perguntar`, { texto }),
    entregar: (id: string, corpo: { resumo?: string; plano?: string; areaPrevista?: string[] } = {}) => chamar("POST", `/tarefas/${seg(id)}/entregar`, corpo),
  };
}
export type Api = ReturnType<typeof criarApi>;
