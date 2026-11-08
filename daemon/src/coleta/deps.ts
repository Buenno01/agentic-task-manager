import type { ArmazemColetas } from "../db/coletas.ts";
import type { ArmazemAnomalias, Anomalia } from "../db/anomalias.ts";
import type { Coletor } from "../domain/coleta.ts";
import type { CategoriaFalha } from "./falha-humana.ts";
import type { ClienteColeta } from "./cliente.ts";
import type { ArmazemRevisoes } from "../db/revisoes.ts";
import type { Mascarador } from "../seguranca/mascarador.ts";

export interface DepsColetas {
  store: ArmazemColetas;
  revisoes: ArmazemRevisoes;
  anomalias: ArmazemAnomalias;
  /**
   * Gancho dos tickets 07/08: chamado uma vez por Anomalia NOVA (reavaliação não repete), logo após persisti-la.
   * Nunca deve lançar; se lançar, a Coleta não é afetada.
   */
  aoDetectarAnomalia?: (anomalia: Anomalia, coletor: Coletor) => void;
  /** Gancho do ticket 08: chamado pelo agendador após a varredura de cada Coletor (fechamento de período). Nunca deve lançar. */
  aoVarrerColetor?: (coletor: Coletor) => void;
  /** Ticket 07: falha que exige ação humana (uma vez por categoria e Coleta). Não deve lançar. */
  aoFalharComAcaoHumana?: (falha: { coletor: Coletor; categoria: CategoriaFalha; period: string; mensagem: string; agora: Date }) => void;
  /** Grava o corpo bruto (já mascarado) de uma resposta com erro, para depuração. Nunca deve lançar. */
  gravarRespostaBruta?: (coletaId: string, period: string, texto: string) => void;
  cliente: ClienteColeta;
  relogio: () => number;
  mascarador: Mascarador;
  contextoExiste: (id: string) => boolean;
  /** Execuções em voo, para o daemon aguardar no close(). */
  emVoo: Set<Promise<void>>;
}
