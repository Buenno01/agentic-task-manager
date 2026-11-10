import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const base = { instructions: "", repository: null, testCommands: null, concurrencyLimit: null, createdAt: "2026-01-01T00:00:00Z" };
const loja = { ...base, id: "c2", name: "Loja Vinhos", kind: "loja", parentId: null, children: [] };

const PLANO = "Passo 1: ajustar o catálogo.\nPasso 2: publicar.";
const T1 = {
  id: "t1",
  title: "Revisar catálogo",
  description: "Conferir preços",
  phase: "Exploração",
  state: "Plano pronto para aprovação",
  createdAt: "2026-01-01T00:00:00Z",
  contextId: "c2",
  priority: { nivel: "alta", origem: "humano" },
  intendedArea: ["src/catalogo/**", "docs/precos.md"],
  overlapWarnings: [{ taskId: "t9", title: "Migrar preços", state: "Explorando", overlaps: [{ mine: "src/catalogo/**", theirs: "src/catalogo/preco.ts" }] }],
};

const plano = {
  id: "p1", tarefaId: "t1", em: "2026-01-01T10:00:00Z", autor: "agente", tipo: "plano", texto: PLANO, de: "", para: "", motivo: "",
};

function api(tarefa: Record<string, unknown> = T1, erro?: { status: number; error: string }) {
  const reg = { acoes: [] as { acao: string; corpo: unknown }[], tarefa };
  server.use(
    http.get("*/api/contextos/arvore", () => HttpResponse.json([loja])),
    http.get("*/api/tarefas", () => HttpResponse.json([reg.tarefa])),
    http.get("*/api/contextos/:id/tarefas", () => HttpResponse.json([reg.tarefa])),
    http.get("*/api/contextos/:id/consolidado", () => HttpResponse.json({ contextId: "c2", version: 1, text: "", createdAt: null })),
    http.get("*/api/contextos/:id/resolvido", () => HttpResponse.json({ id: "c2", path: [], repository: null, testCommands: null, concurrencyLimit: null, instructions: [], instructionsText: "" })),
    http.get("*/api/tarefas/:id", () => HttpResponse.json(reg.tarefa)),
    http.get("*/api/tarefas/:id/eventos", () => HttpResponse.json([plano])),
    http.post("*/api/tarefas/:id/:acao", async ({ params, request }) => {
      const corpo = await request.json().catch(() => null);
      reg.acoes.push({ acao: String(params.acao), corpo });
      if (erro) return HttpResponse.json({ error: erro.error }, { status: erro.status });
      return HttpResponse.json({ ...reg.tarefa, state: "Aprovado" });
    }),
  );
  return reg;
}

const abrir = async () => {
  render(<App initialPath="/?tarefa=t1" />);
  return screen.findByRole("region", { name: "Detalhe da Tarefa" });
};

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("aprovação com confirmação", () => {
  it("o botão Aprovar abre o diálogo com plano, Área prevista e aviso de sobreposição, sem aprovar", async () => {
    const reg = api();
    const p = await abrir();
    await userEvent.click(await within(p).findByRole("button", { name: "Aprovar" }));
    const d = await screen.findByRole("dialog", { name: /Aprovar/ });
    expect(within(d).getByText(/Passo 1: ajustar o catálogo/)).toBeInTheDocument();
    expect(within(d).getByText("src/catalogo/**")).toBeInTheDocument();
    expect(within(d).getByText("docs/precos.md")).toBeInTheDocument();
    expect(within(d).getByText(/Migrar preços/)).toBeInTheDocument();
    expect(within(d).getByText(/src\/catalogo\/preco\.ts/)).toBeInTheDocument();
    expect(reg.acoes).toEqual([]);
  });

  it("o atalho A também abre o diálogo e só confirmar aprova", async () => {
    const reg = api();
    const p = await abrir();
    await within(p).findByRole("button", { name: "Aprovar" });
    await userEvent.keyboard("a");
    const d = await screen.findByRole("dialog", { name: /Aprovar/ });
    expect(reg.acoes).toEqual([]);
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar aprovação" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ acao: "aprovar", corpo: null }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cancelar fecha o diálogo sem chamar a API", async () => {
    const reg = api();
    const p = await abrir();
    await within(p).findByRole("button", { name: "Aprovar" });
    await userEvent.keyboard("a");
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(reg.acoes).toEqual([]);
  });

  it("o atalho não dispara ao digitar num campo", async () => {
    api();
    const p = await abrir();
    await within(p).findByRole("button", { name: "Aprovar" });
    await userEvent.type(within(p).getByRole("textbox", { name: "Comentário" }), "aaa");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("erro 403 da API aparece no diálogo, que continua aberto", async () => {
    api(T1, { status: 403, error: "Apenas o humano pode aprovar" });
    const p = await abrir();
    await userEvent.click(await within(p).findByRole("button", { name: "Aprovar" }));
    const d = await screen.findByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Confirmar aprovação" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Apenas o humano pode aprovar");
  });

  it("rejeitar exige motivo e envia o motivo", async () => {
    const reg = api();
    const p = await abrir();
    await userEvent.click(await within(p).findByRole("button", { name: "Rejeitar" }));
    const d = await screen.findByRole("dialog", { name: /Rejeitar/ });
    const confirmar = within(d).getByRole("button", { name: "Confirmar rejeição" });
    expect(confirmar).toBeDisabled();
    await userEvent.type(within(d).getByRole("textbox", { name: "Motivo" }), "Fora de escopo");
    await userEvent.click(confirmar);
    await waitFor(() => expect(reg.acoes).toEqual([{ acao: "rejeitar", corpo: { motivo: "Fora de escopo" } }]));
  });

  it("Tarefa rejeitada oferece Reabrir, sem Aprovar", async () => {
    const reg = api({ ...T1, state: "Rejeitado" });
    const p = await abrir();
    expect(within(p).queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    await userEvent.click(await within(p).findByRole("button", { name: "Reabrir" }));
    await waitFor(() => expect(reg.acoes).toEqual([{ acao: "reabrir", corpo: null }]));
  });

  it("estados sem ação de Aprovação não mostram botões nem atalho", async () => {
    api({ ...T1, state: "Explorando" });
    const p = await abrir();
    await within(p).findByRole("heading", { name: "Revisar catálogo" });
    expect(within(p).queryByRole("button", { name: /Aprovar|Rejeitar|Reabrir/ })).not.toBeInTheDocument();
    await userEvent.keyboard("a");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
