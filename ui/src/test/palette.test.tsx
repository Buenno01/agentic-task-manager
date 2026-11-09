import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: "c1", children: [] };
const cliente = { ...base, id: "c1", name: "Acme", kind: "cliente", parentId: null, children: [loja] };
const tarefa = (id: string, title: string, state = "Novo") => ({ id, title, description: "", phase: "Exploração", state, createdAt: "2026-01-01T00:00:00Z" });

const RESULTADOS = [
  { tipo: "tarefa", id: "t1", snippet: "Revisar [catálogo] de vinhos", taskId: "t1", contextId: "c2" },
  { tipo: "comentario", id: "m1", snippet: "O [catálogo] está velho", taskId: "t2", contextId: "c2" },
  { tipo: "consolidado", id: "c2", snippet: "Decisão sobre [catálogo]", taskId: null, contextId: "c2", version: 3 },
  { tipo: "anexo", id: "a1", snippet: "planilha do [catálogo]", taskId: "t1", contextId: "c2" },
];

function api() {
  const buscas: string[] = [];
  const posts: unknown[] = [];
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([cliente])),
    http.get("*/api/tarefas", () => HttpResponse.json([tarefa("t1", "Revisar catálogo"), tarefa("t2", "Escolher gateway", "Aguardando humano")])),
    http.get("*/api/tarefas/:id", ({ params }) => HttpResponse.json(tarefa(String(params.id), params.id === "t2" ? "Escolher gateway" : "Revisar catálogo"))),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json([])),
    http.get("*/api/contextos/:id/resolvido", ({ params }) =>
      HttpResponse.json({ id: params.id, path: [], repository: null, testCommands: null, concurrencyLimit: null, instructions: [], instructionsText: "" }),
    ),
    http.get("*/api/contextos/:id/consolidado", ({ params }) => HttpResponse.json({ contextId: params.id, version: 3, text: "Texto consolidado", createdAt: null })),
    http.get("*/api/contextos/:id/tarefas", () => HttpResponse.json([])),
    http.get("*/api/busca", ({ request }) => {
      buscas.push(new URL(request.url).search);
      return HttpResponse.json(RESULTADOS);
    }),
    http.post("*/api/tarefas", async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json(tarefa("t9", "Nova"), { status: 201 });
    }),
  );
  return { buscas, posts };
}

beforeEach(() => localStorage.setItem("atm-token", "t"));

async function abrir() {
  await screen.findByText("Revisar catálogo");
  await userEvent.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: /palette/i });
}

describe("command palette", () => {
  it("Ctrl+K abre e Esc fecha", async () => {
    api();
    render(<App initialPath="/" />);
    await abrir();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /palette/i })).not.toBeInTheDocument());
  });

  it("busca com debounce, agrupa por tipo e escolher Tarefa/comentário/anexo abre a Tarefa", async () => {
    const { buscas } = api();
    render(<App initialPath="/" />);
    const p = await abrir();
    await userEvent.type(within(p).getByRole("combobox"), "catálogo");

    expect(await within(p).findByText("Comentários")).toBeInTheDocument();
    for (const g of ["Tarefas", "Comentários", "Contexto consolidado", "Anexos"]) expect(within(p).getByText(g)).toBeInTheDocument();
    expect(buscas).toHaveLength(1); // debounce: uma só chamada para a palavra inteira
    expect(buscas[0]).toContain("q=cat%C3%A1logo");
    expect(buscas[0]).not.toContain("contexto");

    await userEvent.click(within(p).getByText(/O catálogo está velho/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /palette/i })).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Escolher gateway" })).toBeInTheDocument();
  });

  it("resultado do consolidado abre o Contexto", async () => {
    api();
    render(<App initialPath="/" />);
    const p = await abrir();
    await userEvent.type(within(p).getByRole("combobox"), "catálogo");
    await userEvent.click(await within(p).findByText(/Decisão sobre/));
    expect(await screen.findByText("Texto consolidado")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Loja Vinhos/ })).toHaveAttribute("aria-current", "page");
  });

  it("opção de sub-Contextos e escopo no Contexto atual", async () => {
    const { buscas } = api();
    render(<App initialPath="/?contexto=c1" />);
    await screen.findByText("Texto consolidado");
    await userEvent.keyboard("{Control>}k{/Control}");
    const p = await screen.findByRole("dialog", { name: /palette/i });
    await userEvent.click(within(p).getByRole("checkbox", { name: /sub-contextos/i }));
    await userEvent.type(within(p).getByRole("combobox"), "vinho");
    await within(p).findByText("Tarefas");
    expect(buscas[0]).toContain("contexto=c1");
    expect(buscas[0]).not.toContain("subarvore");
  });

  it("ações: ir para a inbox filtra por Aguardando humano", async () => {
    api();
    render(<App initialPath="/" />);
    const p = await abrir();
    await userEvent.click(within(p).getByText("Ir para a inbox"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /palette/i })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Revisar catálogo")).not.toBeInTheDocument());
    expect(screen.getByText("Escolher gateway")).toBeInTheDocument();
  });

  it("ações: alternar tema e criar Tarefa", async () => {
    const { posts } = api();
    render(<App initialPath="/" />);
    let p = await abrir();
    expect(document.documentElement).toHaveClass("dark");
    await userEvent.click(within(p).getByText("Alternar tema"));
    expect(document.documentElement).not.toHaveClass("dark");

    p = await abrir();
    await userEvent.click(within(p).getByText("Criar Tarefa"));
    const form = await screen.findByRole("dialog", { name: /nova tarefa/i });
    await userEvent.type(within(form).getByLabelText("Título"), "Nova");
    await userEvent.click(within(form).getByRole("button", { name: /criar tarefa/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});
