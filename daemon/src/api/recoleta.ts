import type { DepsColetas } from "./coletas.ts";
import { hashDoSnapshot, normalizarMetricas } from "../domain/coleta.ts";
import { diferencas, janelaDeRecoleta } from "../domain/revisao.ts";
import { detectarAnomalias } from "../coleta/anomalia.ts";
import { agendaDoColetor } from "../domain/agenda.ts";
import type { Coletor } from "../domain/coleta.ts";
import { criarMascarador } from "../seguranca/mascarador.ts";
import { categoriaDaFalha } from "../coleta/falha-humana.ts";

/**
 * Roda a Coleta em segundo plano (RF25): nunca lança; o resultado fica na Coleta.
 * Recoleta a janela do Coletor mais os períodos com Lacuna aberta. Por período:
 * hash igual = nada novo; hash diferente = novo Snapshot + Revisão (se havia anterior);
 * falha = Lacuna (se o período ainda não tem Snapshot); sucesso = recupera a Lacuna.
 */
export async function recolher(d: DepsColetas, coletaId: string): Promise<void> {
  const coleta = d.store.obterColeta(coletaId)!;
  const coletor = d.store.obterColetor(coleta.coletorId)!;
  const agora = () => new Date(d.relogio());
  // O valor do token vive só aqui, em memória; é mascarado em qualquer erro que o cliente devolva.
  const token = process.env[coletor.tokenEnv];
  const mascarar = token ? criarMascarador(() => [token]) : d.mascarador;
  const limpar = (e: unknown) => mascarar.texto(d.mascarador.texto(e instanceof Error ? e.message : String(e)));

  const periodos = [...new Set([...d.revisoes.periodosEmAberto(coletor.id), ...janelaDeRecoleta(coleta.period, coletor.recollectWindowDays)])].sort();
  const erros: string[] = [];
  const jaAvisadas = new Set<string>(); // uma notificação por categoria e Coleta, mesmo com vários períodos
  for (const period of periodos) {
    try {
      if (!token) throw new Error(`Variável de ambiente ${coletor.tokenEnv} não definida`);
      const r = await d.cliente.coletar({ source: coletor.source, params: coletor.params, period, token });
      const payload = normalizarMetricas(r.metricas);
      const hash = hashDoSnapshot(period, r.moeda, payload);
      const anterior = d.store.maisRecentes(coletor.id).find((s) => s.period === period);
      if (!anterior || anterior.hash !== hash) {
        const novo = d.store.gravarSnapshot({ coletorId: coletor.id, coletaId, period, currency: r.moeda, payload, hash }, agora());
        if (anterior)
          d.revisoes.registrarRevisao(
            { coletorId: coletor.id, coletaId, period, previousSnapshotId: anterior.id, snapshotId: novo.id, changes: diferencas(anterior.payload, payload) },
            agora(),
          );
      }
      d.revisoes.recuperarLacuna(coletor.id, period, coletaId, agora());
    } catch (e) {
      const msg = limpar(e);
      erros.push(msg);
      const categoria = categoriaDaFalha(e);
      if (categoria && !jaAvisadas.has(categoria)) {
        jaAvisadas.add(categoria);
        try {
          d.aoFalharComAcaoHumana?.({ coletor, categoria, period, mensagem: msg, agora: agora() });
        } catch {
          // Criar a Tarefa nunca derruba a Coleta.
        }
      }
      if (!d.store.maisRecentes(coletor.id).some((s) => s.period === period)) d.revisoes.abrirLacuna(coletor.id, coletaId, period, msg, agora());
    }
  }
  avaliarAnomalias(d, coletor, agora());
  d.store.concluirColeta(coletaId, erros.length ? erros[0] : null, agora());
}

/** Avalia os dias fechados da série do Coletor; persiste só Anomalias novas e avisa o gancho de cada uma. */
function avaliarAnomalias(d: DepsColetas, coletor: Coletor, agora: Date): void {
  try {
    const { timezone } = agendaDoColetor(coletor.params);
    for (const e of detectarAnomalias(coletor.id, d.store.maisRecentes(coletor.id), coletor.thresholds, agora.getTime(), timezone)) {
      const nova = d.anomalias.registrar(e, agora);
      if (nova) d.aoDetectarAnomalia?.(nova, coletor);
    }
  } catch {
    // A detecção nunca derruba a Coleta.
  }
}
