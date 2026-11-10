import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: null, children: [] };

const tarefa = (id: string, title: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  description: `Descrição de ${title}`,
  phase: "Exploração",
  state,
  createdAt: "2026-01-01T00:00:00Z",
  contextId: "c2",
  priority: { nivel: "média", origem: "padrão" },
  maeId: null,
  subtarefas: [],
  dependeDe: [],
  dependenciasPendentes: [],
  ...extra,
});

const pendente = [{ id: "a1", title: "Migrar tema", state: "Explorando" }];
const NOVO = tarefa("n1", "Criar cupom", "Novo");
const AUTORIZADA = tarefa("n1", "Criar cupom", "Autorizada para explorar", { dependeDe: ["a1"], dependenciasPendentes: pendente });
const AUTORIZADA_LIVRE = tarefa("n1", "Criar cupom", "Autorizada para explorar");
const MAE = tarefa("m1", "Reformar checkout", "Explorando", { subtarefas: [{ id: "s1", title: "Trocar gateway", state: "Novo", decisao: null }] });
const SUB = tarefa("s1", "Trocar gateway", "Novo", { maeId: "m1" });

function api(tarefas: ReturnType<typeof tarefa>[], erro?: { status: number; error: string }) {
  const reg = { acoes: [] as { id: string; acao: string; corpo: unknown }[] };
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([loja])),
    http.get("*/api/tarefas", () => HttpResponse.json(tarefas)),
    http.get("*/api/tarefas/:id", ({ params }) => HttpResponse.json(tarefas.find((t) => t.id === params.id))),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json([])),
    http.post("*/api/tarefas/:id/:acao", async ({ params, request }) => {
      reg.acoes.push({ id: String(params.id), acao: String(params.acao), corpo: await request.json().catch(() => null) });
      if (erro) return HttpResponse.json({ error: erro.error }, { status: erro.status });
      return HttpResponse.json({});
    }),
  );
  return reg;
}

const abrir = async (id: string) => {
  render(<App initialPath={`/?tarefa=${id}`} />);
  return screen.findByRole("region", { name: "Detalhe da Tarefa" });
};

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("Autorizar", () => {
  it("Tarefa em Novo mostra Autorizar no detalhe e chama POST /tarefas/:id/autorizar", async () => {
    const reg = api([NOVO]);
    const p = await abrir("n1");
    await userEvent.click(await within(p).findByRole("button", { name: "Autorizar" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "n1", acao: "autorizar", corpo: null }]));
  });

  it("não mostra Autorizar fora de Novo", async () => {
    api([AUTORIZADA_LIVRE]);
    const p = await abrir("n1");
    await within(p).findByText("Criar cupom");
    expect(within(p).queryByRole("button", { name: "Autorizar" })).not.toBeInTheDocument();
  });

  it("mostra o erro da API quando autorizar falha", async () => {
    api([NOVO], { status: 403, error: "Apenas o humano pode fazer isso" });
    const p = await abrir("n1");
    await userEvent.click(await within(p).findByRole("button", { name: "Autorizar" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("Apenas o humano pode fazer isso");
  });

  it("Subtarefa em Novo na lista da mãe oferece Autorizar", async () => {
    const reg = api([MAE, SUB]);
    const p = await abrir("m1");
    await userEvent.click(await within(p).findByRole("button", { name: "Autorizar Trocar gateway" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "s1", acao: "autorizar", corpo: null }]));
  });
});

describe("Forçar início", () => {
  it("com Dependência pendente pede confirmação e só então chama forcar-inicio com o motivo", async () => {
    const reg = api([AUTORIZADA]);
    const p = await abrir("n1");
    await userEvent.click(await within(p).findByRole("button", { name: "Forçar início" }));
    const d = await screen.findByRole("dialog", { name: /Forçar início/ });
    expect(within(d).getByText(/Migrar tema/)).toBeInTheDocument();
    expect(reg.acoes).toEqual([]);
    await userEvent.type(within(d).getByLabelText("Motivo"), "prazo do cliente");
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar início forçado" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "n1", acao: "forcar-inicio", corpo: { motivo: "prazo do cliente" } }]));
  });

  it("cancelar não chama a API", async () => {
    const reg = api([AUTORIZADA]);
    const p = await abrir("n1");
    await userEvent.click(await within(p).findByRole("button", { name: "Forçar início" }));
    const d = await screen.findByRole("dialog", { name: /Forçar início/ });
    await userEvent.click(within(d).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(reg.acoes).toEqual([]);
  });

  it("sem Dependência pendente não oferece Forçar início", async () => {
    api([AUTORIZADA_LIVRE]);
    const p = await abrir("n1");
    await within(p).findByText("Criar cupom");
    expect(within(p).queryByRole("button", { name: "Forçar início" })).not.toBeInTheDocument();
  });

  it("mostra o erro da API no diálogo e mantém o diálogo aberto", async () => {
    api([AUTORIZADA], { status: 409, error: "Não há dependência pendente; use iniciar" });
    const p = await abrir("n1");
    await userEvent.click(await within(p).findByRole("button", { name: "Forçar início" }));
    const d = await screen.findByRole("dialog", { name: /Forçar início/ });
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar início forçado" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Não há dependência pendente; use iniciar");
  });
});
