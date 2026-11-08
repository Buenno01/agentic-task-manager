import type { ArmazemColetas } from "../db/coletas.ts";
import type { ClienteColeta } from "../coleta/cliente.ts";
import { hashDoSnapshot, METRICAS, normalizarMetricas, periodoDaColeta, validarColetor, type Metrica } from "../domain/coleta.ts";
import { criarMascarador, type Mascarador } from "../seguranca/mascarador.ts";
import type { Resposta } from "./contextos.ts";

const ok = (corpo: unknown, status = 200): Resposta => ({ status, corpo });
const naoEncontrado: Resposta = { status: 404, corpo: { error: "Não encontrado" } };

export interface DepsColetas {
  store: ArmazemColetas;
  cliente: ClienteColeta;
  relogio: () => number;
  mascarador: Mascarador;
  contextoExiste: (id: string) => boolean;
  /** Execuções em voo, para o daemon aguardar no close(). */
  emVoo: Set<Promise<void>>;
}

/** Roda a Coleta em segundo plano (RF25): nunca lança; o resultado fica na Coleta. */
export async function executarColeta(d: DepsColetas, coletaId: string) {
  const coleta = d.store.obterColeta(coletaId)!;
  const coletor = d.store.obterColetor(coleta.coletorId)!;
  const agora = () => new Date(d.relogio());
  // O valor do token vive só aqui, em memória; é mascarado em qualquer erro que o cliente devolva.
  const token = process.env[coletor.tokenEnv];
  const mascarar = token ? criarMascarador(() => [token]) : d.mascarador;
  try {
    if (!token) throw new Error(`Variável de ambiente ${coletor.tokenEnv} não definida`);
    const r = await d.cliente.coletar({ source: coletor.source, params: coletor.params, period: coleta.period, token });
    const payload = normalizarMetricas(r.metricas);
    d.store.gravarSnapshot(
      { coletorId: coletor.id, coletaId, period: coleta.period, currency: r.moeda, payload, hash: hashDoSnapshot(coleta.period, r.moeda, payload) },
      agora(),
    );
    d.store.concluirColeta(coletaId, null, agora());
  } catch (e) {
    const msg = mascarar.texto(d.mascarador.texto(e instanceof Error ? e.message : String(e)));
    d.store.concluirColeta(coletaId, msg, agora());
  }
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
  const mc = path.match(/^\/coletores\/([^/]+)(?:\/(coletas|consolidado)|\/series\/([^/]+))?$/);
  if (mc) {
    const [, id, sub, metrica] = mc;
    if (metodo === "POST" && sub === "coletas" && !humano) return negado;
    const coletor = store.obterColetor(id);
    if (!coletor) return naoEncontrado;
    if (metodo === "GET" && !sub && !metrica) return ok(coletor);
    if (metodo === "GET" && sub === "coletas") return ok(store.listarColetas(id));
    if (metodo === "GET" && sub === "consolidado")
      return ok(store.maisRecentes(id).flatMap((s) => METRICAS.map((m) => ({ period: s.period, metric: m, value: s.payload[m] ?? null, currency: s.currency, snapshotId: s.id }))));
    if (metodo === "GET" && metrica) {
      if (!METRICAS.includes(metrica as Metrica)) return naoEncontrado;
      return ok(store.maisRecentes(id).map((s) => ({ period: s.period, value: s.payload[metrica] ?? null, currency: s.currency, snapshotId: s.id })));
    }
    if (metodo === "POST" && sub === "coletas")
      return corpo().then((e) => {
        const coleta = store.iniciarColeta(id, periodoDaColeta(e.period, d.relogio()), new Date(d.relogio()));
        const p: Promise<void> = executarColeta(d, coleta.id).finally(() => d.emVoo.delete(p));
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
