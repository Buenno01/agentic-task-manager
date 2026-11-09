import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: "c1", children: [] };
const cliente = { ...base, id: "c1", name: "Acme", kind: "cliente", parentId: null, children: [loja] };
const tarefa = (id: string, title: string) => ({ id, title, description: "", phase: "Exploração", state: "Novo", createdAt: "2026-01-01T00:00:00Z" });

function api(arvore: unknown[] = [cliente]) {
  const pedidos: string[] = [];
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json(arvore)),
    http.get("*/api/tarefas", () => HttpResponse.json([tarefa("t1", "Tarefa geral"), tarefa("t2", "Tarefa da loja")])),
    http.get("*/api/contextos/:id/tarefas", ({ request, params }) => {
      pedidos.push(`${params.id}${new URL(request.url).search}`);
      return HttpResponse.json([tarefa("t2", "Tarefa da loja")]);
    }),
    http.get("*/api/contextos/:id/resolvido", ({ params }) =>
      HttpResponse.json({
        id: params.id,
        path: [{ id: "c1", name: "Acme", kind: "cliente" }, { id: "c2", name: "Loja Vinhos", kind: "loja" }],
        repository: "git@x:acme/loja.git",
        testCommands: ["npm test"],
        concurrencyLimit: 2,
        instructions: [],
        instructionsText: "",
      }),
    ),
    http.get("*/api/contextos/:id/consolidado", ({ params }) =>
      HttpResponse.json({ contextId: params.id, version: 3, text: "Decisão: usar Shopify Markets.", createdAt: "2026-01-02T00:00:00Z" }),
    ),
  );
  return pedidos;
}

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("sidebar de Contextos", () => {
  it("renderiza a árvore com hierarquia", async () => {
    api();
    render(<App initialPath="/" />);
    const nav = await screen.findByRole("navigation", { name: "Contextos" });
    const pai = await within(nav).findByRole("link", { name: /Acme/ });
    const filho = within(nav).getByRole("link", { name: /Loja Vinhos/ });
    expect(pai.closest("li")).toContainElement(filho);
    expect(pai.parentElement).not.toBe(filho.parentElement);
  });

  it("selecionar um nó coloca o Contexto na URL, filtra a lista e mostra o consolidado", async () => {
    const pedidos = api();
    render(<App initialPath="/" />);
    expect(await screen.findByText("Tarefa geral")).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("link", { name: /Loja Vinhos/ }));

    expect(await screen.findByText("Decisão: usar Shopify Markets.")).toBeInTheDocument();
    expect(screen.getByText(/versão 3/)).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Loja Vinhos/ })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("Tarefa da loja")).toBeInTheDocument();
    expect(screen.queryByText("Tarefa geral")).not.toBeInTheDocument();
    expect(pedidos).toContain("c2?subarvore");
  });

  it("abrir com ?contexto= na URL já seleciona o nó", async () => {
    api();
    render(<App initialPath="/?contexto=c2" />);
    expect(await screen.findByText("Decisão: usar Shopify Markets.")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Loja Vinhos/ })).toHaveAttribute("aria-current", "page");
  });

  it("Todos os Contextos limpa a seleção", async () => {
    api();
    render(<App initialPath="/?contexto=c2" />);
    await screen.findByText("Decisão: usar Shopify Markets.");
    await userEvent.click(screen.getByRole("link", { name: "Todos os Contextos" }));
    expect(await screen.findByText("Tarefa geral")).toBeInTheDocument();
    expect(screen.queryByText("Decisão: usar Shopify Markets.")).not.toBeInTheDocument();
  });
});

describe("criar Contexto", () => {
  it("envia o formulário completo e o novo Contexto aparece na árvore", async () => {
    let arvore: unknown[] = [];
    let corpo: unknown;
    api();
    server.use(
      http.get("*/api/contextos/arvore", () => HttpResponse.json(arvore)),
      http.post("*/api/contextos", async ({ request }) => {
        corpo = await request.json();
        const novo = { ...base, id: "c9", name: "Acme", kind: "cliente", parentId: null, children: [] };
        arvore = [novo];
        return HttpResponse.json(novo, { status: 201 });
      }),
    );
    render(<App initialPath="/" />);
    await userEvent.click(await screen.findByRole("button", { name: /novo contexto/i }));
    const form = await screen.findByRole("dialog", { name: /novo contexto/i });
    await userEvent.type(within(form).getByLabelText("Nome"), "Acme");
    await userEvent.selectOptions(within(form).getByLabelText("Tipo"), "cliente");
    await userEvent.type(within(form).getByLabelText("Repositório"), "git@x:acme.git");
    await userEvent.type(within(form).getByLabelText(/comandos de teste/i), "npm test");
    await userEvent.type(within(form).getByLabelText(/limite de concorrência/i), "2");
    await userEvent.type(within(form).getByLabelText("Instruções"), "Falar pt-BR");
    await userEvent.click(within(form).getByRole("button", { name: /criar contexto/i }));

    expect(await screen.findByRole("link", { name: /Acme/ })).toBeInTheDocument();
    expect(corpo).toEqual({
      name: "Acme", kind: "cliente", repository: "git@x:acme.git", testCommands: ["npm test"], concurrencyLimit: 2, instructions: "Falar pt-BR",
    });
    expect(screen.queryByRole("dialog", { name: /novo contexto/i })).not.toBeInTheDocument();
  });

  it("mostra o erro de validação do daemon e mantém o formulário aberto", async () => {
    api([]);
    server.use(http.post("*/api/contextos", () => HttpResponse.json({ error: "O nome do Contexto é obrigatório" }, { status: 400 })));
    render(<App initialPath="/" />);
    await userEvent.click(await screen.findByRole("button", { name: /novo contexto/i }));
    const form = await screen.findByRole("dialog", { name: /novo contexto/i });
    await userEvent.click(within(form).getByRole("button", { name: /criar contexto/i }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("O nome do Contexto é obrigatório");
  });
});

describe("responsivo", () => {
  function telaEstreita() {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  }
  afterEach(() => Reflect.deleteProperty(window, "matchMedia"));

  it("abaixo de 1024 px a sidebar vira drawer aberto por botão", async () => {
    telaEstreita();
    api();
    render(<App initialPath="/" />);
    await screen.findByText("Tarefa geral");
    expect(screen.queryByRole("navigation", { name: "Contextos" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /contextos/i }));
    const drawer = await screen.findByRole("dialog", { name: "Contextos" });
    await userEvent.click(await within(drawer).findByRole("link", { name: /Loja Vinhos/ }));
    expect(await screen.findByText("Decisão: usar Shopify Markets.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Contextos" })).not.toBeInTheDocument();
  });
});
