import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: null, children: [] };

const T1 = {
  id: "t1",
  title: "Revisar catálogo",
  description: "Conferir preços do catálogo",
  phase: "Exploração",
  state: "Aguardando humano",
  createdAt: "2026-01-01T00:00:00Z",
  contextId: "c2",
  priority: { nivel: "alta", origem: "humano" },
};
const T2 = { ...T1, id: "t2", title: "Outra", state: "Novo", description: "" };

const trans = (id: number, em: string, de: string, para: string, motivo = "") => ({
  id,
  tarefaId: "t1",
  em,
  autor: "sistema",
  tipo: "transicao",
  de,
  para,
  motivo,
});
const com = (id: string, em: string, tipo: string, texto: string, respondeA?: string) => ({
  id,
  tarefaId: "t1",
  em,
  autor: tipo === "resposta" ? "humano" : "agente",
  tipo,
  texto,
  de: "",
  para: "",
  motivo: "",
  ...(respondeA ? { respondeA } : {}),
});

function api(eventos: unknown[] = []) {
  const reg = { posts: [] as unknown[], eventos, detalhe: 0 };
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([loja])),
    http.get("*/api/tarefas", () => HttpResponse.json([T1, T2])),
    http.get("*/api/contextos/:id/tarefas", () => HttpResponse.json([T1, T2])),
    http.get("*/api/contextos/:id/consolidado", () => HttpResponse.json({ contextId: "c2", version: 1, text: "", createdAt: null })),
    http.get("*/api/contextos/:id/resolvido", () => HttpResponse.json({ id: "c2", path: [], repository: null, testCommands: null, concurrencyLimit: null, instructions: [], instructionsText: "" })),
    http.get("*/api/tarefas/:id", ({ params }) => {
      reg.detalhe++;
      return HttpResponse.json(params.id === "t2" ? T2 : T1);
    }),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json(reg.eventos)),
    http.post("*/api/tarefas/:id/comentarios", async ({ request }) => {
      const corpo = (await request.json()) as { tipo: string; texto: string; respondeA?: string };
      reg.posts.push(corpo);
      const novo = com(`n${reg.posts.length}`, "2026-01-02T10:00:00Z", corpo.tipo, corpo.texto, corpo.respondeA);
      reg.eventos = [...reg.eventos, novo];
      return HttpResponse.json(novo, { status: 201 });
    }),
  );
  return reg;
}

const painel = () => screen.findByRole("region", { name: "Detalhe da Tarefa" });

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("detalhe da Tarefa", () => {
  it("abrir pela lista mostra título, descrição, estado, Prioridade e Contexto", async () => {
    api();
    render(<App initialPath="/" />);
    await userEvent.click(await screen.findByRole("button", { name: "Abrir Revisar catálogo" }));
    const p = await painel();
    expect(await within(p).findByRole("heading", { name: "Revisar catálogo" })).toBeInTheDocument();
    expect(within(p).getByText("Conferir preços do catálogo")).toBeInTheDocument();
    expect(within(p).getByText("Aguardando humano")).toBeInTheDocument();
    expect(within(p).getByText("alta")).toBeInTheDocument();
    expect(await within(p).findByText("Loja Vinhos")).toBeInTheDocument();
  });

  it("link direto /tarefas/:id mostra o mesmo detalhe, mantendo filtros", async () => {
    api();
    render(<App initialPath="/tarefas/t1?estado=Novo" />);
    const p = await painel();
    expect(await within(p).findByRole("heading", { name: "Revisar catálogo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Estado")).toHaveValue("Novo");
  });

  it("Tarefa inexistente mostra erro no painel", async () => {
    api();
    server.use(http.get("*/api/tarefas/:id", () => HttpResponse.json({ error: "Não encontrado" }, { status: 404 })));
    render(<App initialPath="/tarefas/zzz" />);
    expect(await within(await painel()).findByRole("alert")).toHaveTextContent("Não encontrado");
  });

  it("Esc fecha o painel e a URL volta à lista", async () => {
    api();
    render(<App initialPath="/tarefas/t1?estado=Aguardando%20humano" />);
    await within(await painel()).findByRole("heading", { name: "Revisar catálogo" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Detalhe da Tarefa" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Estado")).toHaveValue("Aguardando humano");
  });

  it("Esc dentro do campo de texto não fecha o painel", async () => {
    api();
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await userEvent.type(await within(p).findByLabelText("Comentário"), "oi{Escape}");
    expect(screen.getByRole("region", { name: "Detalhe da Tarefa" })).toBeInTheDocument();
  });
});

describe("histórico", () => {
  it("mostra transições e comentários em linha do tempo, na ordem", async () => {
    api([
      trans(1, "2026-01-01T09:00:00Z", "Novo", "Explorando", "iniciada"),
      com("c1", "2026-01-01T10:00:00Z", "pergunta", "Qual gateway usar?"),
      com("c2", "2026-01-01T11:00:00Z", "comentario", "Vou olhar a Stripe"),
    ]);
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    const itens = await within(p).findAllByRole("listitem");
    expect(itens).toHaveLength(3);
    expect(itens[0]).toHaveTextContent("Novo → Explorando");
    expect(itens[0]).toHaveTextContent("iniciada");
    expect(itens[1]).toHaveTextContent("Pergunta");
    expect(itens[1]).toHaveTextContent("Qual gateway usar?");
    expect(itens[2]).toHaveTextContent("Vou olhar a Stripe");
  });

  it("mostra estado vazio sem eventos", async () => {
    api();
    render(<App initialPath="/?tarefa=t1" />);
    expect(await within(await painel()).findByText("Sem histórico ainda.")).toBeInTheDocument();
  });
});

describe("comentar, perguntar e responder", () => {
  it("comentar envia tipo comentario e o item aparece no histórico", async () => {
    const reg = api();
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await userEvent.type(await within(p).findByLabelText("Comentário"), "Bom ponto");
    await userEvent.click(within(p).getByRole("button", { name: "Comentar" }));
    await waitFor(() => expect(reg.posts).toEqual([{ tipo: "comentario", texto: "Bom ponto" }]));
    expect(await within(p).findByText("Bom ponto")).toBeInTheDocument();
    expect(within(p).getByLabelText("Comentário")).toHaveValue("");
  });

  it("perguntar envia tipo pergunta", async () => {
    const reg = api();
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await userEvent.type(await within(p).findByLabelText("Comentário"), "Quem aprova?");
    await userEvent.click(within(p).getByRole("button", { name: "Perguntar" }));
    await waitFor(() => expect(reg.posts).toEqual([{ tipo: "pergunta", texto: "Quem aprova?" }]));
  });

  it("não envia texto vazio", async () => {
    api();
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await within(p).findByLabelText("Comentário");
    expect(within(p).getByRole("button", { name: "Comentar" })).toBeDisabled();
    expect(within(p).getByRole("button", { name: "Perguntar" })).toBeDisabled();
  });

  it("responde a uma pergunta específica, enviando respondeA", async () => {
    const reg = api([
      com("q1", "2026-01-01T10:00:00Z", "pergunta", "Qual gateway?"),
      com("q2", "2026-01-01T10:30:00Z", "pergunta", "Qual prazo?"),
    ]);
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await within(p).findByText("Qual prazo?");
    await userEvent.click(within(p).getByRole("button", { name: "Responder: Qual prazo?" }));
    expect(within(p).getByText(/Respondendo a/)).toHaveTextContent("Qual prazo?");
    await userEvent.type(within(p).getByLabelText("Comentário"), "Sexta");
    await userEvent.click(within(p).getByRole("button", { name: "Responder" }));
    await waitFor(() => expect(reg.posts).toEqual([{ tipo: "resposta", texto: "Sexta", respondeA: "q2" }]));
    await waitFor(() => expect(within(p).queryByText(/Respondendo a/)).not.toBeInTheDocument());
  });

  it("pergunta já respondida não oferece Responder; a resposta cita a pergunta", async () => {
    api([
      com("q1", "2026-01-01T10:00:00Z", "pergunta", "Qual gateway?"),
      com("r1", "2026-01-01T10:10:00Z", "resposta", "Stripe", "q1"),
    ]);
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await within(p).findByText("Stripe");
    expect(within(p).queryByRole("button", { name: /^Responder:/ })).not.toBeInTheDocument();
    expect(within(p).getByText(/Em resposta a/)).toHaveTextContent("Qual gateway?");
  });

  it("mostra o erro do daemon", async () => {
    api();
    server.use(http.post("*/api/tarefas/:id/comentarios", () => HttpResponse.json({ error: "Texto é obrigatório" }, { status: 400 })));
    render(<App initialPath="/?tarefa=t1" />);
    const p = await painel();
    await userEvent.type(await within(p).findByLabelText("Comentário"), "x");
    await userEvent.click(within(p).getByRole("button", { name: "Comentar" }));
    expect(await within(p).findByRole("alert")).toHaveTextContent("Texto é obrigatório");
  });
});

describe("polling", () => {
  it("o detalhe aberto atualiza sozinho com novos eventos", async () => {
    const reg = api();
    render(<App initialPath="/?tarefa=t1" refetchIntervalMs={50} />);
    const p = await painel();
    await within(p).findByText("Sem histórico ainda.");
    reg.eventos = [com("c9", "2026-01-01T12:00:00Z", "comentario", "Chegou de fora")];
    expect(await within(p).findByText("Chegou de fora")).toBeInTheDocument();
  });
});
