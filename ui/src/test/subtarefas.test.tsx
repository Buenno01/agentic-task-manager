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

const S1 = tarefa("s1", "Trocar gateway", "Novo", { maeId: "m1" });
const S2 = tarefa("s2", "Atualizar frete", "Rejeitado", { maeId: "m1" });
const M1 = tarefa("m1", "Reformar checkout", "Explorando", {
  subtarefas: [
    { id: "s1", title: "Trocar gateway", state: "Novo", decisao: null },
    { id: "s2", title: "Atualizar frete", state: "Rejeitado", decisao: "rejeitada" },
  ],
});
const A1 = tarefa("a1", "Migrar tema", "Explorando");
const X1 = tarefa("x1", "Publicar loja", "Novo", {
  dependeDe: ["a1"],
  dependenciasPendentes: [{ id: "a1", title: "Migrar tema", state: "Explorando" }],
});

function api(tarefas: ReturnType<typeof tarefa>[]) {
  const reg = {
    acoes: [] as { id: string; acao: string; corpo: unknown }[],
    patches: [] as { id: string; corpo: unknown }[],
    deps: [] as string[],
    tarefas,
  };
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([loja])),
    http.get("*/api/tarefas", () => HttpResponse.json(reg.tarefas)),
    http.get("*/api/tarefas/:id", ({ params }) => HttpResponse.json(reg.tarefas.find((t) => t.id === params.id))),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json([])),
    http.post("*/api/tarefas/:id/dependencias", async ({ params, request }) => {
      const { dependeDe } = (await request.json()) as { dependeDe: string };
      reg.deps.push(`+${params.id}>${dependeDe}`);
      return HttpResponse.json({ id: params.id }, { status: 201 });
    }),
    http.delete("*/api/tarefas/:id/dependencias/:a", ({ params }) => {
      reg.deps.push(`-${params.id}>${params.a}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch("*/api/tarefas/:id", async ({ params, request }) => {
      reg.patches.push({ id: String(params.id), corpo: await request.json() });
      return HttpResponse.json({});
    }),
    http.post("*/api/tarefas/:id/:acao", async ({ params, request }) => {
      reg.acoes.push({ id: String(params.id), acao: String(params.acao), corpo: await request.json().catch(() => null) });
      return HttpResponse.json({});
    }),
  );
  return reg;
}

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("Subtarefas na lista", () => {
  it("aninha a Subtarefa sob a mãe, sem repeti-la no topo, e recolhe", async () => {
    api([M1, S1, S2]);
    render(<App initialPath="/" />);
    await screen.findByRole("button", { name: "Abrir Reformar checkout" });
    const sub = await screen.findByRole("button", { name: "Abrir Trocar gateway" });
    expect(screen.getAllByRole("button", { name: "Abrir Trocar gateway" })).toHaveLength(1);
    expect(sub.closest("ul")?.closest("li")).toHaveTextContent("Reformar checkout");

    const alternar = screen.getByRole("button", { name: "Recolher Subtarefas de Reformar checkout" });
    expect(alternar).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(alternar);
    expect(screen.queryByRole("button", { name: "Abrir Trocar gateway" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expandir Subtarefas de Reformar checkout" }));
    expect(await screen.findByRole("button", { name: "Abrir Trocar gateway" })).toBeInTheDocument();
  });
});

describe("Dependência como aviso brando", () => {
  it("a linha mostra ícone com tooltip e continua abrindo a Tarefa", async () => {
    api([A1, X1]);
    render(<App initialPath="/" />);
    const aviso = await screen.findByLabelText("Dependência pendente: Publicar loja");
    await userEvent.hover(aviso);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Depende de Migrar tema \(Explorando\)/);
    expect(screen.queryByLabelText("Dependência pendente: Migrar tema")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abrir Publicar loja" }));
    expect(await screen.findByRole("region", { name: "Detalhe da Tarefa" })).toBeInTheDocument();
  });

  it("o detalhe lista a Dependência pendente e permite remover", async () => {
    const reg = api([A1, X1]);
    render(<App initialPath="/?tarefa=x1" />);
    const p = await screen.findByRole("region", { name: "Detalhe da Tarefa" });
    const secao = await within(p).findByRole("region", { name: "Dependências" });
    expect(within(secao).getByText(/Migrar tema/)).toBeInTheDocument();
    expect(within(secao).getByText(/pendente/i)).toBeInTheDocument();
    await userEvent.click(within(secao).getByRole("button", { name: "Remover dependência de Migrar tema" }));
    await waitFor(() => expect(reg.deps).toEqual(["-x1>a1"]));
  });

  it("o detalhe adiciona Dependência escolhendo outra Tarefa", async () => {
    const reg = api([A1, X1]);
    render(<App initialPath="/?tarefa=a1" />);
    const p = await screen.findByRole("region", { name: "Detalhe da Tarefa" });
    const secao = await within(p).findByRole("region", { name: "Dependências" });
    const escolha = await within(secao).findByRole("combobox", { name: "Depende de" });
    expect(within(escolha).queryByRole("option", { name: "Migrar tema" })).not.toBeInTheDocument();
    await userEvent.selectOptions(escolha, "x1");
    await userEvent.click(within(secao).getByRole("button", { name: "Adicionar dependência" }));
    await waitFor(() => expect(reg.deps).toEqual(["+a1>x1"]));
  });

  it("erro da API ao adicionar (ciclo) aparece sem travar", async () => {
    api([A1, X1]);
    server.use(http.post("*/api/tarefas/:id/dependencias", () => HttpResponse.json({ error: "Dependência criaria um ciclo" }, { status: 400 })));
    render(<App initialPath="/?tarefa=a1" />);
    const secao = await screen.findByRole("region", { name: "Dependências" });
    await userEvent.selectOptions(await within(secao).findByRole("combobox", { name: "Depende de" }), "x1");
    await userEvent.click(within(secao).getByRole("button", { name: "Adicionar dependência" }));
    expect(await within(secao).findByRole("alert")).toHaveTextContent("Dependência criaria um ciclo");
  });
});

describe("ações individuais em Subtarefas", () => {
  const abrirMae = async () => {
    render(<App initialPath="/?tarefa=m1" />);
    const p = await screen.findByRole("region", { name: "Detalhe da Tarefa" });
    return within(await within(p).findByRole("region", { name: "Subtarefas" }));
  };

  it("o detalhe da mãe lista as Subtarefas", async () => {
    api([M1, S1, S2]);
    const sec = await abrirMae();
    expect(sec.getByText("Trocar gateway")).toBeInTheDocument();
    expect(sec.getByText("Atualizar frete")).toBeInTheDocument();
  });

  it("aprovar só chama a API depois de confirmar no diálogo (aprovar-subtarefa)", async () => {
    const reg = api([M1, S1, S2]);
    const sec = await abrirMae();
    await userEvent.click(sec.getByRole("button", { name: "Aprovar Trocar gateway" }));
    const d = await screen.findByRole("dialog", { name: /Aprovar: Trocar gateway/ });
    expect(reg.acoes).toEqual([]);
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar aprovação" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "s1", acao: "aprovar-subtarefa", corpo: null }]));
  });

  it("rejeitar exige motivo e age só nessa Subtarefa", async () => {
    const reg = api([M1, S1, S2]);
    const sec = await abrirMae();
    await userEvent.click(sec.getByRole("button", { name: "Rejeitar Trocar gateway" }));
    const d = await screen.findByRole("dialog", { name: /Rejeitar: Trocar gateway/ });
    await userEvent.type(within(d).getByRole("textbox", { name: "Motivo" }), "Fora de escopo");
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar rejeição" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "s1", acao: "rejeitar", corpo: { motivo: "Fora de escopo" } }]));
  });

  it("reabrir uma Subtarefa rejeitada", async () => {
    const reg = api([M1, S1, S2]);
    const sec = await abrirMae();
    expect(sec.queryByRole("button", { name: "Aprovar Atualizar frete" })).not.toBeInTheDocument();
    await userEvent.click(sec.getByRole("button", { name: "Reabrir Atualizar frete" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "s2", acao: "reabrir", corpo: null }]));
  });

  it("ajustar edita título e descrição via PATCH", async () => {
    const reg = api([M1, S1, S2]);
    const sec = await abrirMae();
    await userEvent.click(sec.getByRole("button", { name: "Ajustar Trocar gateway" }));
    const d = await screen.findByRole("dialog", { name: /Ajustar: Trocar gateway/ });
    const titulo = within(d).getByRole("textbox", { name: "Título" });
    await waitFor(() => expect(within(d).getByRole("textbox", { name: "Descrição" })).toHaveValue("Descrição de Trocar gateway"));
    await userEvent.clear(titulo);
    await userEvent.type(titulo, "Trocar provedor");
    await userEvent.click(within(d).getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(reg.patches).toEqual([{ id: "s1", corpo: { title: "Trocar provedor", description: "Descrição de Trocar gateway" } }]),
    );
  });

  it("no detalhe da própria Subtarefa em Novo, Aprovar também passa pela confirmação", async () => {
    const reg = api([M1, S1, S2]);
    render(<App initialPath="/?tarefa=s1" />);
    const p = await screen.findByRole("region", { name: "Detalhe da Tarefa" });
    await userEvent.click(await within(p).findByRole("button", { name: "Aprovar" }));
    const d = await screen.findByRole("dialog");
    expect(reg.acoes).toEqual([]);
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar aprovação" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ id: "s1", acao: "aprovar-subtarefa", corpo: null }]));
  });
});
