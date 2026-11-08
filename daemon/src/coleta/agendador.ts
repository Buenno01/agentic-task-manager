import { agendaDoColetor, BACKFILL_DIAS, somarDias, ultimoPeriodoDevido } from "../domain/agenda.ts";
import type { DepsColetas } from "../api/coletas.ts";
import { recolher } from "../api/recoleta.ts";

export interface OpcoesAgendador {
  /** Agenda a varredura periódica e devolve o cancelamento. Injetável: os testes não esperam timers. */
  agendar?: (varrer: () => void) => () => void;
}

export const INTERVALO_AGENDADOR_MS = 60_000;

/** Varredura periódica real: setInterval que não segura o processo. */
export const agendarComTimer =
  (ms = INTERVALO_AGENDADOR_MS) =>
  (varrer: () => void) => {
    const t = setInterval(varrer, ms);
    t.unref();
    return () => clearInterval(t);
  };

const INTERROMPIDA = "Interrompida (daemon reiniciou)";

/**
 * Agendador das Coletas diárias. Cada varredura compara o relógio com o horário do Coletor (no fuso da loja)
 * e coleta, em ordem, os períodos devidos que ainda não têm Coleta. Mesma lógica no boot (recuperação,
 * ADR-0004): atrasadas e interrompidas rodam, as que já rodaram não se repetem. Sem Coleta nenhuma
 * o Coletor recebe o backfill de 90 dias.
 */
export function criarAgendador(d: DepsColetas, opcoes: OpcoesAgendador = {}) {
  let parando = false;
  let fila: Promise<void> = Promise.resolve();

  /** Períodos já tratados: com Snapshot, ou com Coleta que não foi só interrompida pelo reinício. */
  const cobertos = (coletorId: string) => {
    const set = new Set(d.store.maisRecentes(coletorId).map((s) => s.period));
    for (const c of d.store.listarColetas(coletorId)) if (!(c.state === "falhou" && c.error === INTERROMPIDA)) set.add(c.period);
    return set;
  };

  async function varrerColetor(coletorId: string, agoraMs: number) {
    const coletor = d.store.obterColetor(coletorId)!;
    if (coletor.frequency !== "diaria") return;
    const ultimo = ultimoPeriodoDevido(agoraMs, agendaDoColetor(coletor.params));
    for (let i = BACKFILL_DIAS - 1; i >= 0 && !parando; i--) {
      const periodo = somarDias(ultimo, -i);
      // Reconsulta a cada período: outro processo (ou uma Coleta manual) pode tê-lo coberto.
      if (cobertos(coletorId).has(periodo)) continue;
      const coleta = d.store.iniciarColeta(coletorId, periodo, new Date(d.relogio()));
      await recolher(d, coleta.id);
    }
  }

  async function varrerTudo() {
    for (const c of d.store.listarColetores()) {
      if (parando) return;
      try {
        await varrerColetor(c.id, d.relogio());
      } catch (e) {
        console.error(`Falha no agendador de Coletas (${c.id}):`, e instanceof Error ? e.message : e);
      }
    }
  }

  // Varreduras em fila: nunca duas ao mesmo tempo, para não duplicar períodos.
  const varrer = () => {
    const p = fila.then(varrerTudo);
    fila = p;
    d.emVoo.add(p);
    void p.finally(() => d.emVoo.delete(p));
    return p;
  };
  const cancelar = (opcoes.agendar ?? agendarComTimer())(() => void varrer());

  return {
    varrer,
    parar() {
      parando = true;
      cancelar();
    },
  };
}
export type Agendador = ReturnType<typeof criarAgendador>;
