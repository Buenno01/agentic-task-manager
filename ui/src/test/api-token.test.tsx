import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { createQueryClient } from "@/lib/api-provider";
import { http, HttpResponse, server } from "./server";

const tarefa = { id: "t1", title: "Primeira tarefa", description: "", phase: "Exploração", state: "Novo", createdAt: "2026-01-01T00:00:00Z" };

describe("token e conexão com a API", () => {
  it("sem token pede o token, não chama a API; depois de salvo envia Bearer e não pergunta de novo", async () => {
    const auth: (string | null)[] = [];
    server.use(
      http.get("*/api/tarefas", ({ request }) => {
        auth.push(request.headers.get("authorization"));
        return HttpResponse.json([tarefa]);
      }),
    );
    const { unmount } = render(<App />);
    expect(await screen.findByRole("dialog", { name: /token/i })).toBeInTheDocument();
    expect(auth).toEqual([]);

    await userEvent.type(screen.getByLabelText("Token"), "segredo-123");
    await userEvent.click(screen.getByRole("button", { name: /salvar/i }));

    expect(await screen.findByText("Primeira tarefa")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(auth[0]).toBe("Bearer segredo-123");
    expect(localStorage.getItem("atm-token")).toBe("segredo-123");

    unmount();
    render(<App />);
    expect(await screen.findByText("Primeira tarefa")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("401 mostra aviso de token recusado e reabre o diálogo; novo token corrige", async () => {
    localStorage.setItem("atm-token", "errado");
    server.use(
      http.get("*/api/tarefas", ({ request }) =>
        request.headers.get("authorization") === "Bearer certo"
          ? HttpResponse.json([tarefa])
          : HttpResponse.json({ error: "Não autenticado" }, { status: 401 }),
      ),
    );
    render(<App />);
    const dialogo = await screen.findByRole("dialog", { name: /token/i });
    expect(dialogo).toHaveTextContent(/recusado/i);

    await userEvent.type(screen.getByLabelText("Token"), "certo");
    await userEvent.click(screen.getByRole("button", { name: /salvar/i }));
    expect(await screen.findByText("Primeira tarefa")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("API fora do ar mostra aviso de conexão sem quebrar a tela nem pedir token", async () => {
    localStorage.setItem("atm-token", "ok");
    server.use(http.get("*/api/tarefas", () => HttpResponse.error()));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/não foi possível conectar/i);
    expect(screen.getByRole("heading", { name: /agentic task manager/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("o aviso de conexão some quando a API volta", async () => {
    localStorage.setItem("atm-token", "ok");
    let fora = true;
    server.use(http.get("*/api/tarefas", () => (fora ? HttpResponse.error() : HttpResponse.json([tarefa]))));
    render(<App refetchIntervalMs={20} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fora = false;
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("Primeira tarefa")).toBeInTheDocument();
  });
});

describe("polling", () => {
  it("é de 5 s e não roda com a aba oculta", () => {
    const d = createQueryClient().getDefaultOptions().queries!;
    expect(d.refetchInterval).toBe(5000);
    expect(d.refetchIntervalInBackground).toBe(false);
  });
});
