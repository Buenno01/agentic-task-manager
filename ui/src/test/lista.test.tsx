import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: "c1", children: [] };
const cliente = { ...base, id: "c1", name: "Acme", kind: "cliente", parentId: null, children: [loja] };

const tarefa = (id: string, title: string, state: string, nivel = "média") => ({
  id,
  title,
  description: "",
  phase: "Exploração",
  state,
  createdAt: "2026-01-01T00:00:00Z",
  priority: { nivel, origem: "padrão" },
});

const TAREFAS = [
  tarefa("t1", "Revisar catálogo", "Novo"),
  tarefa("t2", "Escolher gateway", "Aguardando humano", "urgente"),
  tarefa("t3", "Migrar tema", "Plano pronto para aprovação", "alta"),
  tarefa("t4", "Ajustar frete", "Novo", "baixa"),
  tarefa("t5", "Definir domínio", "Aguardando humano"),
];

function api(tarefas = TAREFAS) {
  const reg = { subarvore: [] as string[], posts: [] as unknown[], puts: [] as unknown[] };
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([cliente])),
    http.get("*/api/tarefas", () => HttpResponse.json(tarefas)),
    http.get("*/api/contextos/:id/tarefas", ({ request, params }) => {
      reg.subarvore.push(`${params.id}${new URL(request.url).search}`);
      return HttpResponse.json(tarefas.filter((t) => t.id === "t1" || t.id === "t2"));
    }),
    http.get("*/api/tarefas/:id", ({ params }) => HttpResponse.json(tarefas.find((t) => t.id === params.id) ?? { error: "Não encontrado" })),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json([])),
    http.post("*/api/tarefas", async ({ request }) => {
      const corpo = await request.json();
      reg.posts.push(corpo);
      return HttpResponse.json(tarefa("t9", (corpo as { title: string }).title, "Novo"), { status: 201 });
    }),
    http.put("*/api/tarefas/:id/prioridade", async ({ request, params }) => {
      reg.puts.push({ id: params.id, corpo: await request.json() });
      return HttpResponse.json({ nivel: "alta", origem: "humano" });
    }),
  );
  return reg;
}

const titulosDosGrupos = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\d+$/, "").trim());

beforeEach(() => {
  localStorage.setItem("atm-token", "t");
  document.title = "Agentic Task Manager";
});

describe("lista de Tarefas", () => {
  it("agrupa por estado, com Aguardando humano primeiro, e mostra a Prioridade de cada linha", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");

    expect(titulosDosGrupos()).toEqual(["Aguardando humano", "Plano pronto para aprovação", "Novo"]);
    const grupo = screen.getByRole("region", { name: "Novo" });
    expect(within(grupo).getByText("Revisar catálogo")).toBeInTheDocument();
    expect(within(grupo).getByText("Ajustar frete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prioridade de Escolher gateway: urgente" })).toBeInTheDocument();
  });

  it("mostra estado vazio quando não há Tarefas", async () => {
    api([]);
    render(<App initialPath="/" />);
    expect(await screen.findByText("Nenhuma Tarefa encontrada.")).toBeInTheDocument();
  });
});

describe("filtros na URL", () => {
  it("estado e Prioridade da URL filtram a lista e aparecem nos controles", async () => {
    api();
    render(<App initialPath="/?estado=Novo&prioridade=baixa" />);
    expect(await screen.findByText("Ajustar frete")).toBeInTheDocument();
    expect(screen.queryByText("Revisar catálogo")).not.toBeInTheDocument();
    expect(screen.queryByText("Escolher gateway")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Estado")).toHaveValue("Novo");
    expect(screen.getByLabelText("Prioridade")).toHaveValue("baixa");
  });

  it("trocar o filtro de estado atualiza a lista", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    await userEvent.selectOptions(screen.getByLabelText("Estado"), "Novo");
    await waitFor(() => expect(screen.queryByText("Escolher gateway")).not.toBeInTheDocument());
    expect(screen.getByText("Revisar catálogo")).toBeInTheDocument();
  });

  it("filtra por Prioridade", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    await userEvent.selectOptions(screen.getByLabelText("Prioridade"), "urgente");
    await waitFor(() => expect(screen.queryByText("Revisar catálogo")).not.toBeInTheDocument());
    expect(screen.getByText("Escolher gateway")).toBeInTheDocument();
  });

  it("sub-Contextos vêm ligados; desligar tira ?subarvore do pedido", async () => {
    const reg = api();
    render(<App initialPath="/?contexto=c2" />);
    await screen.findByText("Revisar catálogo");
    expect(reg.subarvore[0]).toBe("c2?subarvore");
    const caixa = screen.getByRole("checkbox", { name: "Incluir sub-Contextos" });
    expect(caixa).toBeChecked();

    await userEvent.click(caixa);
    await waitFor(() => expect(reg.subarvore).toContain("c2"));
    expect(screen.getByRole("checkbox", { name: "Incluir sub-Contextos" })).not.toBeChecked();
  });

  it("subcontextos=false na URL abre com a caixa desligada", async () => {
    const reg = api();
    render(<App initialPath="/?contexto=c2&subcontextos=false" />);
    await screen.findByText("Revisar catálogo");
    expect(reg.subarvore[0]).toBe("c2");
    expect(screen.getByRole("checkbox", { name: "Incluir sub-Contextos" })).not.toBeChecked();
  });
});

describe("inbox Aguardando humano", () => {
  it("mostra o contador, põe no título da aba e filtra ao clicar", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    const inbox = screen.getByRole("button", { name: /Aguardando humano/ });
    await waitFor(() => expect(within(inbox).getByText("2")).toBeInTheDocument());
    await waitFor(() => expect(document.title).toBe("(2) Agentic Task Manager"));

    await userEvent.click(inbox);
    await waitFor(() => expect(screen.queryByText("Revisar catálogo")).not.toBeInTheDocument());
    expect(screen.getByText("Escolher gateway")).toBeInTheDocument();
    expect(screen.getByText("Definir domínio")).toBeInTheDocument();
    expect(screen.getByLabelText("Estado")).toHaveValue("Aguardando humano");
  });

  it("sem Tarefas aguardando, o título fica sem contador", async () => {
    api([tarefa("t1", "Revisar catálogo", "Novo")]);
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    expect(document.title).toBe("Agentic Task Manager");
  });
});

describe("criar Tarefa", () => {
  it("envia título, descrição e Contexto pela lista e mostra a nova Tarefa após atualizar", async () => {
    const reg = api();
    render(<App initialPath="/?contexto=c2" />);
    await screen.findByText("Revisar catálogo");

    await userEvent.click(screen.getByRole("button", { name: "Nova Tarefa" }));
    const dialogo = await screen.findByRole("dialog", { name: "Nova Tarefa" });
    await userEvent.type(within(dialogo).getByLabelText("Título"), "Cobrar fornecedor");
    await userEvent.type(within(dialogo).getByLabelText("Descrição"), "Prazo na sexta");
    expect(within(dialogo).getByLabelText("Contexto")).toHaveValue("c2");
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar Tarefa" }));

    await waitFor(() => expect(reg.posts).toEqual([{ title: "Cobrar fornecedor", description: "Prazo na sexta", contextId: "c2" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("mostra o erro do daemon e mantém o formulário aberto", async () => {
    api();
    server.use(http.post("*/api/tarefas", () => HttpResponse.json({ error: "O título da Tarefa é obrigatório" }, { status: 400 })));
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    await userEvent.click(screen.getByRole("button", { name: "Nova Tarefa" }));
    const dialogo = await screen.findByRole("dialog", { name: "Nova Tarefa" });
    await userEvent.click(within(dialogo).getByRole("button", { name: "Criar Tarefa" }));
    expect(await within(dialogo).findByRole("alert")).toHaveTextContent("O título da Tarefa é obrigatório");
  });
});

describe("Prioridade na linha", () => {
  it("o popover altera só a Prioridade, enviando o nível", async () => {
    const reg = api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");

    await userEvent.click(screen.getByRole("button", { name: "Prioridade de Revisar catálogo: média" }));
    await userEvent.click(await screen.findByRole("button", { name: "alta" }));

    await waitFor(() => expect(reg.puts).toEqual([{ id: "t1", corpo: { nivel: "alta" } }]));
  });

  it("não oferece edição livre de estado", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    await userEvent.click(screen.getByRole("button", { name: "Prioridade de Revisar catálogo: média" }));
    const opcoes = (await screen.findAllByRole("button")).map((b) => b.textContent);
    expect(opcoes).toEqual(expect.arrayContaining(["baixa", "média", "alta", "urgente"]));
    // Estado só aparece como filtro (select) e cabeçalho de grupo; nenhuma linha tem controle de estado.
    expect(screen.queryByRole("combobox", { name: /mover|alterar estado/i })).not.toBeInTheDocument();
  });
});

describe("teclado", () => {
  it("setas percorrem as linhas e Enter abre a Tarefa no painel", async () => {
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Revisar catálogo");
    const linhas = () => screen.getAllByRole("button", { name: /^Abrir / });
    linhas()[0].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(linhas()[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}");
    expect(linhas()[1]).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Definir domínio" })).toBeInTheDocument();
  });

  it("?tarefa= na URL abre o painel de detalhe", async () => {
    api();
    render(<App initialPath="/?tarefa=t3" />);
    expect(await screen.findByRole("heading", { name: "Migrar tema" })).toBeInTheDocument();
  });
});
