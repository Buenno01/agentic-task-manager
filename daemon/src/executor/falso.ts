import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { EntradaRodada, Executor } from "./executor.ts";

const git = promisify(execFile);

/** Um passo do roteiro do adaptador falso. */
export type Passo =
  | { passo: string }
  | { segmento: { modelo: string; provedor: string } }
  | { commit: { arquivo: string; conteudo: string; mensagem: string } }
  | { tokens: { entrada: number; saida: number; chamadas?: number; custo?: number } }
  /** Chamada à API real com o token de agente; `{tarefa}` no caminho vira o id da Tarefa. */
  | { api: { metodo: string; caminho: string; corpo?: unknown } }
  | { pergunta: string }
  | { entrega: string }
  | { falha: string }
  /** Anuncia o pid do processo do agente (evento "processo"). */
  | { processo: number }
  | { morrer: true };

export type Roteiro = Passo[];

/** Executor determinístico movido por roteiro: sem modelo, sem custo. `prompts` guarda o prompt recebido em cada Rodada. */
export function criarExecutorFalso(roteiro: Roteiro): Executor & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async executar(e: EntradaRodada) {
      prompts.push(e.prompt);
      const chamar = async (metodo: string, caminho: string, corpo?: unknown) => {
        const r = await fetch(e.ambiente.ATM_API_URL + caminho.replaceAll("{tarefa}", e.tarefaId), {
          method: metodo,
          headers: { authorization: `Bearer ${e.ambiente.ATM_AGENT_TOKEN}`, "content-type": "application/json" },
          body: corpo === undefined ? undefined : JSON.stringify(corpo).replaceAll("{tarefa}", e.tarefaId),
        });
        await r.arrayBuffer();
        e.emitir({ tipo: "api", dados: { metodo, caminho, status: r.status } });
      };
      for (const p of roteiro) {
        if (e.sinal.aborted) throw new Error("Rodada cancelada");
        if ("passo" in p) e.emitir({ tipo: "passo", dados: { texto: p.passo } });
        else if ("segmento" in p) e.emitir({ tipo: "segmento", dados: p.segmento });
        else if ("tokens" in p) e.emitir({ tipo: "tokens", dados: p.tokens });
        else if ("commit" in p) {
          const c = p.commit;
          const alvo = join(e.workspace, c.arquivo);
          mkdirSync(dirname(alvo), { recursive: true });
          writeFileSync(alvo, c.conteudo);
          await git("git", ["add", "--", c.arquivo], { cwd: e.workspace });
          await git("git", ["-c", "user.name=falso", "-c", "user.email=falso@atm.local", "commit", "-q", "-m", c.mensagem], { cwd: e.workspace });
          e.emitir({ tipo: "comando", dados: { comando: `git commit -m ${JSON.stringify(c.mensagem)}`, arquivos: [c.arquivo] } });
        } else if ("api" in p) await chamar(p.api.metodo, p.api.caminho, p.api.corpo);
        else if ("pergunta" in p) {
          await chamar("POST", "/tarefas/{tarefa}/perguntar", { texto: p.pergunta });
          e.emitir({ tipo: "pergunta", dados: { texto: p.pergunta } });
        } else if ("entrega" in p) {
          await chamar("POST", "/tarefas/{tarefa}/entregar", { resumo: p.entrega });
          e.emitir({ tipo: "entrega", dados: { resumo: p.entrega } });
        }
        else if ("processo" in p) e.emitir({ tipo: "processo", dados: { pid: p.processo } });
        else if ("falha" in p) throw new Error(p.falha);
        else if ("morrer" in p) throw new Error("Processo do agente morreu (SIGKILL)");
      }
    },
  };
}
