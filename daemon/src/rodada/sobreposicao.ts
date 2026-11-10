import type { ArmazemRodadas } from "../db/rodadas.ts";
import type { Repositorio } from "../db/index.ts";
import { areasSobrepoem, type TarefaParaSobreposicao } from "../domain/area.ts";
import { arquivosAlteradosDesde } from "./retomada.ts";

const FECHADOS = ["Rejeitado", "Concluído"];

export interface DepsSobreposicao {
  repo: Repositorio;
  rodadas: ArmazemRodadas;
  /** Tarefas com repositório e Área prevista (mesma visão do aviso prévio do Núcleo). */
  visao: () => TarefaParaSobreposicao[];
}

/**
 * Aviso de sobreposição real: compara os arquivos que a Rodada alterou no Workspace com a Área prevista
 * das outras Tarefas abertas do mesmo repositório, com a mesma regra de `areasSobrepoem` do Núcleo.
 * Só avisa (evento da Rodada e histórico da Tarefa); nunca bloqueia nem lança.
 */
export function criarVigiaSobreposicao(d: DepsSobreposicao) {
  return {
    /** Devolve `verificar()` para uma Rodada; cada interseção nova é avisada uma única vez. */
    para(rodadaId: string, tarefaId: string, workspace: string) {
      const avisados = new Set<string>();
      return async () => {
        try {
          const todas = d.visao();
          const eu = todas.find((t) => t.id === tarefaId);
          if (!eu?.repository) return;
          const outras = todas.filter((o) => o.id !== tarefaId && o.repository === eu.repository && !FECHADOS.includes(o.state) && o.area.length);
          if (!outras.length) return;
          const arquivos = await arquivosAlteradosDesde(workspace, null);
          for (const o of outras) {
            const novas: { arquivo: string; area: string }[] = [];
            for (const arquivo of arquivos)
              for (const area of o.area) {
                const chave = `${o.id}\0${arquivo}\0${area}`;
                if (areasSobrepoem(arquivo, area) && !avisados.has(chave)) {
                  avisados.add(chave);
                  novas.push({ arquivo, area });
                }
              }
            if (!novas.length) continue;
            d.rodadas.registrarEvento(rodadaId, "aviso-sobreposicao", { tarefaId: o.id, titulo: o.title, estado: o.state, sobreposicoes: novas });
            d.repo.registrarEvento(tarefaId, {
              autor: "sistema",
              tipo: "aviso-sobreposicao",
              motivo: `Sobreposição real com "${o.title}" (${o.id}): ${novas.map((n) => `${n.arquivo} ~ ${n.area}`).join(", ")}`,
            });
          }
        } catch {
          // Aviso é informativo: falha aqui nunca derruba a Rodada.
        }
      };
    },
  };
}
