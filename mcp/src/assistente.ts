import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErroApi, type Api } from "./api.ts";

const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

async function executar(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof ErroApi ? e.message : `Falha ao chamar a API: ${e instanceof Error ? e.message : String(e)}`;
    return { isError: true, content: [{ type: "text" as const, text: msg }] };
  }
}

/** Transições que o assistente pode pedir. As demais (aprovar, forçar início, converter, concluir) são portões humanos. */
export const ACOES_LIVRES = [
  "autorizar", "iniciar", "pedir-humano", "retomar", "plano-pronto", "rejeitar", "reabrir",
  "iniciar-execucao", "aguardar-humano-execucao", "retomar-execucao", "validar-execucao",
] as const;
export const ACOES_PORTAO = ["aprovar", "aprovar-subtarefa", "forcar-inicio", "converter-execucao", "concluir-execucao"] as const;

const seg = encodeURIComponent;

/**
 * Perfil "assistente": opera o sistema em nome do humano (token humano), com cobertura total da API
 * de organização: Contextos, Tarefas, prioridade, dependências, anexos, Coletores, consolidado.
 * Os portões de aprovação (ACOES_PORTAO) ficam de fora, a menos que `permitirAprovacao` esteja ligado:
 * o padrão preserva "agente nunca aprova a própria execução" (ADR-0001) quando o assistente é um LLM.
 */
export function criarServidorAssistente(api: Api, opts: { permitirAprovacao?: boolean } = {}): McpServer {
  const s = new McpServer({ name: "agentic-task-manager-assistente", version: "0.1.0" });
  const get = (p: string) => api.chamar("GET", p);

  // ---- Contextos
  s.registerTool("listar_contextos", { description: "Lista todos os Contextos (planos).", inputSchema: {} }, () => executar(() => get("/contextos")));
  s.registerTool("arvore_contextos", { description: "Árvore hierárquica de Contextos.", inputSchema: {} }, () => executar(() => get("/contextos/arvore")));
  s.registerTool(
    "ler_contexto",
    { description: "Lê um Contexto: instruções resolvidas da cadeia e consolidado atual.", inputSchema: { contextoId: z.string() } },
    ({ contextoId }) =>
      executar(async () => ({
        resolvido: await get(`/contextos/${seg(contextoId)}/resolvido`),
        consolidado: await get(`/contextos/${seg(contextoId)}/consolidado`),
      })),
  );
  const configCtx = {
    instructions: z.string().optional(),
    repository: z.string().nullable().optional(),
    referenceRepositories: z.array(z.string()).nullable().optional(),
    testCommands: z.array(z.string()).nullable().optional(),
    concurrencyLimit: z.number().int().min(1).nullable().optional(),
    deliveryMode: z.enum(["branch-local", "pr"]).nullable().optional(),
  };
  s.registerTool(
    "criar_contexto",
    {
      description: "Cria um Contexto (nó hierárquico). kind: cliente, projeto, repositorio, loja ou ambiente. parentId opcional.",
      inputSchema: { name: z.string(), kind: z.enum(["cliente", "projeto", "repositorio", "loja", "ambiente"]), parentId: z.string().optional(), ...configCtx },
    },
    (corpo) => executar(() => api.chamar("POST", "/contextos", corpo)),
  );
  s.registerTool(
    "editar_contexto",
    {
      description: "Edita campos de um Contexto (só os informados mudam; null herda do pai).",
      inputSchema: { contextoId: z.string(), name: z.string().optional(), kind: z.enum(["cliente", "projeto", "repositorio", "loja", "ambiente"]).optional(), ...configCtx },
    },
    ({ contextoId, ...corpo }) => executar(() => api.chamar("PATCH", `/contextos/${seg(contextoId)}`, corpo)),
  );
  s.registerTool(
    "atualizar_consolidado",
    { description: "Grava nova versão do Contexto consolidado (texto completo).", inputSchema: { contextoId: z.string(), text: z.string(), tarefaId: z.string().optional() } },
    ({ contextoId, text, tarefaId }) => executar(() => api.chamar("PUT", `/contextos/${seg(contextoId)}/consolidado`, { text, taskId: tarefaId })),
  );
  s.registerTool(
    "reverter_consolidado",
    { description: "Reverte o consolidado para uma versão (padrão: a anterior). Cria nova versão, não apaga histórico.", inputSchema: { contextoId: z.string(), version: z.number().int().optional() } },
    ({ contextoId, version }) => executar(() => api.chamar("POST", `/contextos/${seg(contextoId)}/consolidado/reverter`, version === undefined ? {} : { version })),
  );
  s.registerTool(
    "listar_tarefas_do_contexto",
    { description: "Tarefas de um Contexto, opcionalmente com a subárvore.", inputSchema: { contextoId: z.string(), subarvore: z.boolean().optional() } },
    ({ contextoId, subarvore }) => executar(() => get(`/contextos/${seg(contextoId)}/tarefas${subarvore ? "?subarvore=1" : ""}`)),
  );

  // ---- Tarefas
  s.registerTool("listar_tarefas", { description: "Lista todas as Tarefas ordenadas por prioridade, com fase, estado e Contexto.", inputSchema: {} }, () => executar(() => get("/tarefas")));
  s.registerTool(
    "ler_tarefa",
    { description: "Lê uma Tarefa com histórico de eventos, dados de Execução, dependências e anexos.", inputSchema: { id: z.string() } },
    ({ id }) =>
      executar(async () => ({
        tarefa: await get(`/tarefas/${seg(id)}`),
        eventos: await get(`/tarefas/${seg(id)}/eventos`),
        execucao: await get(`/tarefas/${seg(id)}/execucao`),
        anexos: await get(`/tarefas/${seg(id)}/anexos`),
      })),
  );
  s.registerTool(
    "buscar",
    { description: "Busca textual em Tarefas, comentários, consolidados e anexos.", inputSchema: { q: z.string(), contextoId: z.string().optional(), subarvore: z.boolean().optional() } },
    ({ q, contextoId, subarvore }) => executar(() => api.buscar(q, contextoId, subarvore)),
  );
  s.registerTool(
    "criar_tarefa",
    {
      description:
        "Cria uma Tarefa (ou Subtarefa com parentId). Por padrão nasce em Exploração · Novo. " +
        "Para criar direto na Execução (fila), passe phase='Execução' com objetivo, repositorioPrincipal e criterios.",
      inputSchema: {
        title: z.string(), description: z.string().optional(), contextId: z.string().optional(), parentId: z.string().optional(),
        phase: z.enum(["Exploração", "Execução"]).optional(),
        objetivo: z.string().optional(), repositorioPrincipal: z.string().optional(),
        criterios: z.array(z.string()).optional(), entregaveis: z.array(z.string()).optional(), permissoes: z.array(z.string()).optional(),
      },
    },
    (corpo) => executar(() => api.criarTarefa(corpo)),
  );
  s.registerTool(
    "criar_varias_tarefas",
    {
      description: "Popula várias Tarefas de uma vez (Exploração · Novo). Devolve o resultado de cada uma, sem abortar nas falhas.",
      inputSchema: { tarefas: z.array(z.object({ title: z.string(), description: z.string().optional(), contextId: z.string().optional(), parentId: z.string().optional() })).min(1).max(100) },
    },
    ({ tarefas }) =>
      executar(async () => {
        const out: unknown[] = [];
        for (const t of tarefas) {
          try { out.push({ ok: true, tarefa: await api.criarTarefa(t) }); }
          catch (e) { out.push({ ok: false, titulo: t.title, erro: e instanceof Error ? e.message : String(e) }); }
        }
        return out;
      }),
  );
  s.registerTool(
    "editar_tarefa",
    { description: "Edita título e/ou descrição de uma Tarefa.", inputSchema: { id: z.string(), title: z.string().optional(), description: z.string().optional() } },
    ({ id, ...corpo }) => executar(() => api.chamar("PATCH", `/tarefas/${seg(id)}`, corpo)),
  );
  s.registerTool(
    "editar_execucao",
    {
      description: "Edita o contrato de Execução/plano (campo-chave alterado em tarefa aprovada ou em execução volta a exigir aprovação).",
      inputSchema: {
        id: z.string(), objetivo: z.string().optional(), repositorioPrincipal: z.string().optional(),
        criterios: z.array(z.string()).optional(), entregaveis: z.array(z.string()).optional(), permissoes: z.array(z.string()).optional(),
      },
    },
    ({ id, ...corpo }) => executar(() => api.chamar("PATCH", `/tarefas/${seg(id)}/execucao`, corpo)),
  );
  s.registerTool(
    "mover_tarefa_de_contexto",
    { description: "Associa a Tarefa a um Contexto (contextId null remove a associação).", inputSchema: { id: z.string(), contextId: z.string().nullable() } },
    ({ id, contextId }) => executar(() => api.chamar("PUT", `/tarefas/${seg(id)}/contexto`, { contextId })),
  );
  s.registerTool(
    "definir_prioridade",
    {
      description: "Define a prioridade. Justificativa é opcional para o humano.",
      inputSchema: { id: z.string(), nivel: z.enum(["baixa", "média", "alta", "urgente"]), impacto: z.string().optional(), urgencia: z.string().optional(), esforco: z.string().optional() },
    },
    ({ id, ...corpo }) => executar(() => api.chamar("PUT", `/tarefas/${seg(id)}/prioridade`, corpo)),
  );
  s.registerTool(
    "adicionar_dependencia",
    { description: "Declara que a Tarefa id depende de dependeDe.", inputSchema: { id: z.string(), dependeDe: z.string() } },
    ({ id, dependeDe }) => executar(() => api.chamar("POST", `/tarefas/${seg(id)}/dependencias`, { dependeDe })),
  );
  s.registerTool(
    "remover_dependencia",
    { description: "Remove a dependência de id em relação a dependeDe.", inputSchema: { id: z.string(), dependeDe: z.string() } },
    ({ id, dependeDe }) => executar(() => api.chamar("DELETE", `/tarefas/${seg(id)}/dependencias/${seg(dependeDe)}`)),
  );
  s.registerTool(
    "definir_area_prevista",
    { description: "Define os caminhos previstos que a Tarefa tocará (detecta sobreposição).", inputSchema: { id: z.string(), paths: z.array(z.string()) } },
    ({ id, paths }) => executar(() => api.chamar("PUT", `/tarefas/${seg(id)}/area-prevista`, { paths })),
  );
  s.registerTool(
    "comentar",
    {
      description: "Comenta numa Tarefa. tipo: comentario (padrão), pergunta ou resposta (resposta exige respondeA = id da pergunta; devolve a Tarefa ao andamento).",
      inputSchema: { tarefaId: z.string(), texto: z.string(), tipo: z.enum(["comentario", "pergunta", "resposta"]).optional(), respondeA: z.string().optional() },
    },
    ({ tarefaId, texto, tipo, respondeA }) => executar(() => api.comentar(tarefaId, { tipo, texto, respondeA })),
  );
  s.registerTool(
    "anexar_texto",
    { description: "Anexa um arquivo de texto a uma Tarefa ou Contexto.", inputSchema: { donoTipo: z.enum(["tarefas", "contextos"]), donoId: z.string(), nome: z.string(), conteudo: z.string() } },
    ({ donoTipo, donoId, nome, conteudo }) => executar(() => api.enviarTexto(`/${donoTipo}/${seg(donoId)}/anexos?nome=${seg(nome)}`, conteudo)),
  );

  const acoes = opts.permitirAprovacao ? [...ACOES_LIVRES, ...ACOES_PORTAO] : [...ACOES_LIVRES];
  s.registerTool(
    "transicionar_tarefa",
    {
      description:
        `Muda o estado de uma Tarefa. Ações: ${acoes.join(", ")}. ` +
        (opts.permitirAprovacao ? "Atenção: inclui aprovação de plano e conversão para Execução." : "Aprovar plano, forçar início, converter para Execução e concluir são do humano na UI."),
      inputSchema: { id: z.string(), acao: z.enum(acoes as [string, ...string[]]), motivo: z.string().optional() },
    },
    ({ id, acao, motivo }) => executar(() => api.chamar("POST", `/tarefas/${seg(id)}/${acao}`, { motivo: motivo ?? "" })),
  );
  if (opts.permitirAprovacao) {
    s.registerTool(
      "converter_em_execucao",
      {
        description: "Converte uma Tarefa de Exploração em Execução (fila). Exige objetivo, repositorioPrincipal e criterios.",
        inputSchema: {
          id: z.string(), objetivo: z.string(), repositorioPrincipal: z.string(), criterios: z.array(z.string()).min(1),
          entregaveis: z.array(z.string()).optional(), permissoes: z.array(z.string()).optional(),
        },
      },
      ({ id, ...corpo }) => executar(() => api.chamar("POST", `/tarefas/${seg(id)}/converter-execucao`, corpo)),
    );
  }
  s.registerTool(
    "iniciar_rodada",
    { description: "Inicia uma Rodada do agente executor numa Tarefa autorizada/na fila.", inputSchema: { id: z.string() } },
    ({ id }) => executar(() => api.chamar("POST", `/tarefas/${seg(id)}/rodadas`, {})),
  );
  s.registerTool(
    "listar_rodadas",
    { description: "Lista Rodadas e Checkpoints de uma Tarefa.", inputSchema: { id: z.string() } },
    ({ id }) => executar(async () => ({ rodadas: await get(`/tarefas/${seg(id)}/rodadas`), checkpoints: await get(`/tarefas/${seg(id)}/checkpoints`) })),
  );

  // ---- Monitoramento
  const coletorId = { coletorId: z.string() };
  s.registerTool("listar_coletores", { description: "Lista os Coletores.", inputSchema: {} }, () => executar(() => api.coletores()));
  s.registerTool("ler_coletor", { description: "Lê um Coletor.", inputSchema: coletorId }, ({ coletorId }) => executar(() => api.coletor(coletorId)));
  s.registerTool(
    "criar_coletor",
    {
      description: "Cria um Coletor. tokenEnv é o NOME da variável de ambiente do daemon com o token da fonte, nunca o valor.",
      inputSchema: {
        contextId: z.string(), source: z.string(), tokenEnv: z.string(), frequency: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(), recollectWindowDays: z.number().int().optional(),
        automaticAnalysis: z.boolean().optional(), thresholds: z.record(z.string(), z.number()).optional(),
      },
    },
    (corpo) => executar(() => api.chamar("POST", "/coletores", corpo)),
  );
  s.registerTool("disparar_coleta", { description: "Dispara uma Coleta sob demanda.", inputSchema: coletorId }, ({ coletorId }) => executar(() => api.chamar("POST", `/coletores/${seg(coletorId)}/coletas`, {})));
  s.registerTool("ler_anomalias", { description: "Anomalias de um Coletor.", inputSchema: coletorId }, ({ coletorId }) => executar(() => api.anomalias(coletorId)));
  s.registerTool("ler_lacunas", { description: "Lacunas de um Coletor.", inputSchema: coletorId }, ({ coletorId }) => executar(() => api.lacunas(coletorId)));
  s.registerTool("ler_revisoes", { description: "Revisões de um Coletor.", inputSchema: coletorId }, ({ coletorId }) => executar(() => api.revisoes(coletorId)));

  // ---- Operação
  s.registerTool("uso_da_tarefa", { description: "Uso de tokens/custo das Rodadas de uma Tarefa.", inputSchema: { id: z.string() } }, ({ id }) => executar(() => get(`/tarefas/${seg(id)}/uso`)));

  return s;
}
