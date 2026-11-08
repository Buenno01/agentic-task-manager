import type { DepsColetas } from "../coleta/deps.ts";
import { agendaDoColetor } from "../domain/agenda.ts";
import { METRICAS, chaveDeProduto, ehMetricaDeSnapshot, lerChaveDeProduto, periodoDaColeta, validarColetor } from "../domain/coleta.ts";
import { recolher } from "../coleta/recoleta.ts";
import { rotaAnomalias } from "./anomalias.ts";
import { rotaRevisoes } from "./revisoes.ts";
import type { Resposta } from "./contextos.ts";

const ok = (corpo: unknown, status = 200): Resposta => ({ status, corpo });
export const naoEncontrado: Resposta = { status: 404, corpo: { error: "Não encontrado" } };

/** GET /coletores/:id/<sufixos> (alternativas separadas por `|`): 404 se o Coletor não existe, senão `ler(id, sufixo)`. */
export function rotaLeituraDoColetor(
  d: DepsColetas,
  metodo: string,
  path: string,
  sufixos: string,
  ler: (coletorId: string, sufixo: string) => unknown,
): Resposta | undefined {
  const m = path.match(new RegExp(`^/coletores/([^/]+)/(${sufixos})$`));
  if (!m || metodo !== "GET") return undefined;
  if (!d.store.obterColetor(m[1])) return naoEncontrado;
  return ok(ler(m[1], m[2]));
}

/** Quebra por produto: unidades e receita de cada produto por período (só produtos presentes no Snapshot). */
function quebraPorProduto(snapshots: { period: string; payload: Record<string, number | null> }[]) {
  return snapshots.flatMap((s) => {
    const ids = new Set<string>();
    for (const k of Object.keys(s.payload)) {
      const p = lerChaveDeProduto(k);
      if (p) ids.add(p.id);
    }
    return [...ids].map((productId) => ({
      period: s.period,
      productId,
      units: s.payload[chaveDeProduto(productId, "unidades")] ?? null,
      revenue: s.payload[chaveDeProduto(productId, "receita")] ?? null,
    }));
  });
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
  // Escrita sobre Coletor ou Coleta é só do humano (ADR-0001, ADR-0005): o agente recebe 403 em qualquer método que não leia.
  if (!humano && metodo !== "GET" && /^\/(coletores|coletas)(\/|$)/.test(path)) return negado;
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
  const respAnomalias = rotaAnomalias(d, metodo, path);
  if (respAnomalias) return respAnomalias;
  const mc = path.match(/^\/coletores\/([^/]+)(?:\/(coletas|consolidado|produtos)|\/series\/([^/]+))?$/);
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
    if (metodo === "GET" && sub === "produtos") return ok(quebraPorProduto(store.maisRecentes(id)));
    if (metodo === "GET" && metrica) {
      const nome = decodeURIComponent(metrica);
      if (!ehMetricaDeSnapshot(nome)) return naoEncontrado;
      return ok(store.maisRecentes(id).map((s) => ({ period: s.period, value: s.payload[nome] ?? null, currency: s.currency, snapshotId: s.id })));
    }
    if (metodo === "POST" && sub === "coletas")
      return corpo().then((e) => {
        const coleta = store.iniciarColeta(id, periodoDaColeta(e.period, d.relogio(), agendaDoColetor(coletor.params).timezone), new Date(d.relogio()));
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
