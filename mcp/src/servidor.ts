import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErroApi, type Api } from "./api.ts";

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

/** Erros da API viram resultado de ferramenta com isError, sem reinterpretação. */
async function executar(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof ErroApi ? e.message : `Falha ao chamar a API: ${e instanceof Error ? e.message : String(e)}`;
    return { isError: true, content: [{ type: "text" as const, text: msg }] };
  }
}

/**
 * Ferramentas para agentes. Propositalmente não há aprovação, autorização, transição de
 * estado nem execução: o agente só lê, busca, comenta e cria em "Novo" (ADR-0001).
 */
export function criarServidorMcp(api: Api): McpServer {
  const s = new McpServer({ name: "agentic-task-manager", version: "0.1.0" });

  s.registerTool(
    "ler_contexto",
    {
      description: "Lê um Contexto: instruções resolvidas da cadeia de Contextos e o consolidado versionado atual.",
      inputSchema: { contextoId: z.string() },
    },
    ({ contextoId }) =>
      executar(async () => {
        const [resolvido, consolidado] = await Promise.all([api.contextoResolvido(contextoId), api.consolidado(contextoId)]);
        return { resolvido, consolidado };
      }),
  );

  s.registerTool(
    "buscar",
    {
      description: "Busca textual em Tarefas, comentários, consolidados e anexos, opcionalmente dentro de um Contexto.",
      inputSchema: { q: z.string(), contextoId: z.string().optional(), subarvore: z.boolean().optional() },
    },
    ({ q, contextoId, subarvore }) => executar(() => api.buscar(q, contextoId, subarvore)),
  );

  s.registerTool(
    "comentar",
    {
      description: "Comenta numa Tarefa. tipo: comentario (padrão), pergunta ou resposta (esta exige respondeA = id da pergunta).",
      inputSchema: {
        tarefaId: z.string(),
        texto: z.string(),
        tipo: z.enum(["comentario", "pergunta", "resposta"]).optional(),
        respondeA: z.string().optional(),
      },
    },
    ({ tarefaId, texto, tipo, respondeA }) => executar(() => api.comentar(tarefaId, { tipo, texto, respondeA })),
  );

  s.registerTool(
    "criar_tarefa",
    {
      description: "Cria uma Tarefa na Exploração em estado Novo. A aprovação é sempre do humano.",
      inputSchema: { title: z.string(), description: z.string().optional(), contextId: z.string().optional() },
    },
    ({ title, description, contextId }) => executar(() => api.criarTarefa({ title, description, contextId })),
  );

  s.registerTool(
    "criar_subtarefa",
    {
      description: "Cria uma Subtarefa em estado Novo ligada à Tarefa-mãe (parentId).",
      inputSchema: { parentId: z.string(), title: z.string(), description: z.string().optional(), contextId: z.string().optional() },
    },
    ({ parentId, title, description, contextId }) => executar(() => api.criarTarefa({ parentId, title, description, contextId })),
  );

  s.registerTool(
    "ler_tarefa",
    {
      description: "Lê uma Tarefa (estado, Subtarefas) e seu histórico de eventos (transições e comentários).",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      executar(async () => {
        const [tarefa, eventos] = await Promise.all([api.tarefa(id), api.eventos(id)]);
        return { tarefa, eventos };
      }),
  );

  return s;
}
