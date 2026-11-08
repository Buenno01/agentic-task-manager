import type { ArmazemColetas } from "../db/coletas.ts";
import type { ClienteColeta } from "../coleta/cliente.ts";
import type { ArmazemRevisoes } from "../db/revisoes.ts";
import { METRICAS, ehMetricaDeSnapshot, periodoDaColeta, validarColetor } from "../domain/coleta.ts";
import type { Mascarador } from "../seguranca/mascarador.ts";
import { recolher } from "./recoleta.ts";
import { rotaRevisoes } from "./revisoes.ts";
import type { Resposta } from "./contextos.ts";

const ok = (corpo: unknown, status = 200): Resposta => ({ status, corpo });
const naoEncontrado: Resposta = { status: 404, corpo: { error: "Não encontrado" } };

export interface DepsColetas {
  store: ArmazemColetas;
  revisoes: ArmazemRevisoes;
  cliente: ClienteColeta;
  relogio: () => number;
  mascarador: Mascarador;
  contextoExiste: (id: string) => boolean;
  /** Execuções em voo, para o daemon aguardar no close(). */
  emVoo: Set<Promise<void>>;
}

/** Rotas /coletores*, /coletas/:id e /snapshots/:id. Devolve undefined quando a rota não é daqui. */
export function rotaColetas(
  d: DepsColetas,
  metodo: string,
  path: string,
  humano: boolean,
  corpo: () => Promise<Record<string, unknown>>,
  negado: Resposta,
): Promise<Resposta> | Resposta | undefined {
  const { store } = d;
  if (path === "/coletores") {
    if (metodo === "GET") return ok(store.listarColetores());
    if (metodo === "POST") {
      if (!humano) return negado;
      return corpo().then((e) => ok(store.criarColetor(validarColetor(e, d.contextoExiste)), 201));
    }
    return undefined;
  }
  const respRevisoes = rotaRevisoes(d, metodo, path);
  if (respRevisoes) return respRevisoes;
  const mc = path.match(/^\/coletores\/([^/]+)(?:\/(coletas|consolidado)|\/series\/([^/]+))?$/);
  if (mc) {
    const [, id, sub, metrica] = mc;
    if (metodo === "POST" && sub === "coletas" && !humano) return negado;
    const coletor = store.obterColetor(id);
    if (!coletor) return naoEncontrado;
    if (metodo === "GET" && !sub && !metrica) return ok(coletor);
    if (metodo === "GET" && sub === "coletas") return ok(store.listarColetas(id));
    if (metodo === "GET" && sub === "consolidado")
      return ok(
        store.maisRecentes(id).flatMap((s) => {
          // as métricas-base sempre aparecem (ausente = null); extras e quebra por produto, só as presentes
          const nomes = [...new Set([...METRICAS, ...Object.keys(s.payload)])];
          return nomes.map((m) => ({ period: s.period, metric: m, value: s.payload[m] ?? null, currency: s.currency, snapshotId: s.id }));
        }),
      );
    if (metodo === "GET" && metrica) {
      const nome = decodeURIComponent(metrica);
      if (!ehMetricaDeSnapshot(nome)) return naoEncontrado;
      return ok(store.maisRecentes(id).map((s) => ({ period: s.period, value: s.payload[nome] ?? null, currency: s.currency, snapshotId: s.id })));
    }
    if (metodo === "POST" && sub === "coletas")
      return corpo().then((e) => {
        const coleta = store.iniciarColeta(id, periodoDaColeta(e.period, d.relogio()), new Date(d.relogio()));
        const p: Promise<void> = recolher(d, coleta.id).finally(() => d.emVoo.delete(p));
        d.emVoo.add(p);
        return ok(coleta, 202);
      });
    return undefined;
  }
  const mcol = path.match(/^\/coletas\/([^/]+)$/);
  if (mcol && metodo === "GET") {
    const c = store.obterColeta(mcol[1]);
    return c ? ok(c) : naoEncontrado;
  }
  const ms = path.match(/^\/snapshots\/([^/]+)$/);
  if (ms && metodo === "GET") {
    const s = store.obterSnapshot(ms[1]);
    return s ? ok(s) : naoEncontrado;
  }
  return undefined;
}
