import type { DepsColetas } from "./deps.ts";
import { hashDoSnapshot, normalizarMetricas } from "../domain/coleta.ts";
import { diferencas, janelaDeRecoleta } from "../domain/revisao.ts";
import { detectarAnomalias } from "../coleta/anomalia.ts";
import { agendaDoColetor } from "../domain/agenda.ts";
import type { Coletor } from "../domain/coleta.ts";
import { criarMascarador } from "../seguranca/mascarador.ts";
import { categoriaDaFalha, ErroExigeAcaoHumana, type CategoriaFalha } from "./falha-humana.ts";

export interface OpcoesRecolher {
  /** Coleta só o período da Coleta, sem recoletar a janela nem as Lacunas abertas (backfill: a Coleta final da varredura as cobre). */
  soPeriodo?: boolean;
  /** Não avalia Anomalias (histórico antigo nunca vira Anomalia nem Tarefa de análise). */
  semAnomalias?: boolean;
}

/**
 * Roda a Coleta em segundo plano (RF25): nunca lança; o resultado fica na Coleta.
 * Recoleta a janela do Coletor mais os períodos com Lacuna aberta. Por período:
 * hash igual = nada novo; hash diferente = novo Snapshot + Revisão (se havia anterior);
 * falha = Lacuna (se o período ainda não tem Snapshot); sucesso = recupera a Lacuna.
 * Anomalias: só os períodos recoletados por esta Coleta são avaliados (nunca todo o histórico).
 */
export async function recolher(d: DepsColetas, coletaId: string, opcoes: OpcoesRecolher = {}): Promise<void> {
  const coleta = d.store.obterColeta(coletaId)!;
  const coletor = d.store.obterColetor(coleta.coletorId)!;
  const agora = () => new Date(d.relogio());
  // O valor do token vive só aqui, em memória; é mascarado em qualquer erro que o cliente devolva.
  const token = process.env[coletor.tokenEnv];
  const mascarar = token ? criarMascarador(() => [token]) : d.mascarador;
  const limpar = (e: unknown) => mascarar.texto(d.mascarador.texto(e instanceof Error ? e.message : String(e)));

  const periodos = opcoes.soPeriodo
    ? [coleta.period]
    : [...new Set([...d.revisoes.periodosEmAberto(coletor.id), ...janelaDeRecoleta(coleta.period, coletor.recollectWindowDays)])].sort();
  const erros: string[] = [];
  let parcial = false;
  const jaAvisadas = new Set<string>(); // uma notificação por categoria e Coleta, mesmo com vários períodos
  const avisar = (categoria: CategoriaFalha, period: string, mensagem: string) => {
    if (jaAvisadas.has(categoria)) return;
    jaAvisadas.add(categoria);
    try {
      d.aoFalharComAcaoHumana?.({ coletor, categoria, period, mensagem, agora: agora() });
    } catch {
      // Criar a Tarefa nunca derruba a Coleta.
    }
  };
  for (const period of periodos) {
    try {
      if (!token) throw new ErroExigeAcaoHumana("token-ausente", `Variável de ambiente ${coletor.tokenEnv} não definida`);
      const r = await d.cliente.coletar({ source: coletor.source, params: coletor.params, period, token });
      const anterior = d.store.maisRecentes(coletor.id).find((s) => s.period === period);
      // Coleta parcial: métrica ausente fica explícita (null, nunca zero nem o valor de uma Coleta anterior) e abre Lacuna parcial.
      const faltando = r.parcial?.faltando ?? [];
      for (const m of faltando) r.metricas[m] = null;
      const payload = normalizarMetricas(r.metricas);
      const hash = hashDoSnapshot(period, r.moeda, payload);
      if (!anterior || anterior.hash !== hash) {
        const novo = d.store.gravarSnapshot({ coletorId: coletor.id, coletaId, period, currency: r.moeda, payload, hash }, agora());
        if (anterior)
          d.revisoes.registrarRevisao(
            { coletorId: coletor.id, coletaId, period, previousSnapshotId: anterior.id, snapshotId: novo.id, changes: diferencas(anterior.payload, payload) },
            agora(),
          );
      }
      if (r.parcial && faltando.length) {
        parcial = true;
        d.revisoes.abrirLacuna(coletor.id, coletaId, period, limpar(r.parcial.erro), agora(), { causa: r.parcial.causa, faltando });
        // Analytics indisponível por plano/escopo exige ação humana; a Coleta segue parcial. "analytics-falhou" é transitório.
        if (r.parcial.causa === "analytics-indisponivel") avisar("analytics", period, limpar(r.parcial.erro));
      } else d.revisoes.recuperarLacuna(coletor.id, period, coletaId, agora());
    } catch (e) {
      const msg = limpar(e);
      erros.push(msg);
      const categoria = categoriaDaFalha(e);
      if (categoria) avisar(categoria, period, msg);
      guardarRespostaBruta(d, coletaId, period, e, limpar);
      if (!d.store.maisRecentes(coletor.id).some((s) => s.period === period)) d.revisoes.abrirLacuna(coletor.id, coletaId, period, msg, agora());
    }
  }
  if (!opcoes.semAnomalias) avaliarAnomalias(d, coletor, periodos, agora());
  d.store.concluirColeta(coletaId, erros.length ? erros[0] : null, agora(), parcial);
}

/** Resposta crua que causou o erro (já mascarada), só em disco e só para depuração; falha ao gravar nunca afeta a Coleta. */
function guardarRespostaBruta(d: DepsColetas, coletaId: string, period: string, e: unknown, limpar: (e: unknown) => string): void {
  const bruto = (e as { respostaBruta?: unknown } | null)?.respostaBruta;
  if (typeof bruto !== "string") return;
  try {
    d.gravarRespostaBruta?.(coletaId, period, limpar(bruto));
  } catch {
    // Disco de depuração indisponível não derruba a Coleta.
  }
}

/** Avalia só os períodos desta Coleta (janela recoletada); persiste só Anomalias novas e avisa o gancho de cada uma. */
function avaliarAnomalias(d: DepsColetas, coletor: Coletor, periodos: string[], agora: Date): void {
  try {
    const { timezone } = agendaDoColetor(coletor.params);
    for (const e of detectarAnomalias(coletor.id, d.store.maisRecentes(coletor.id), coletor.thresholds, agora.getTime(), timezone, periodos)) {
      const nova = d.anomalias.registrar(e, agora);
      if (nova) d.aoDetectarAnomalia?.(nova, coletor);
    }
  } catch {
    // A detecção nunca derruba a Coleta.
  }
}
