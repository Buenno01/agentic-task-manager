import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";
import { http, HttpResponse, server } from "./server";

const ULTIMA = {
  resultado: "rollback", tag_de: "v0.2.0", tag_para: "v0.3.0", motivo: "healthcheck falhou após a troca",
  em: "2026-11-10T12:00:00Z", versao_rodando: "0.2.0", backup: "/run/backup",
};

function api(estado: Record<string, unknown>) {
  const reg = { pedidos: 0, estado: { versao: "0.2.0", configurada: true, estado: "disponivel", pedidoPendente: false, ultima: null, ...estado } as Record<string, unknown> };
  server.use(
    http.get("*/api/tarefas", () => HttpResponse.json([])),
    http.get("*/api/contextos/arvore", () => HttpResponse.json([])),
    http.get("*/api/atualizacao", () => HttpResponse.json(reg.estado)),
    http.post("*/api/atualizacao/pedido", () => {
      reg.pedidos++;
      reg.estado.pedidoPendente = true;
      return HttpResponse.json({ aceito: true, jaPendente: false }, { status: 202 });
    }),
  );
  return reg;
}

beforeEach(() => localStorage.setItem("atm-token", "t"));

describe("versão e botão Atualizar", () => {
  it("mostra a versão em execução e o botão quando configurada", async () => {
    api({});
    render(<App />);
    expect(await screen.findByText("v0.2.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeInTheDocument();
  });

  it("sem configuração: mostra a versão, sem botão e sem mensagem de erro", async () => {
    api({ configurada: false, estado: "indisponivel" });
    render(<App />);
    expect(await screen.findByText("v0.2.0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Atualizar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("pedido recusado (403/409) não derruba nem mostra erro, e não há botão", async () => {
    server.use(
      http.get("*/api/tarefas", () => HttpResponse.json([])),
      http.get("*/api/contextos/arvore", () => HttpResponse.json([])),
      http.get("*/api/atualizacao", () => HttpResponse.json({ error: "Apenas o humano" }, { status: 403 })),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Agentic Task Manager" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("button", { name: "Atualizar" })).not.toBeInTheDocument();
  });

  it("confirmação cita a interrupção das Rodadas e só então envia o pedido", async () => {
    const reg = api({});
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Atualizar" }));
    const d = await screen.findByRole("dialog", { name: /Atualizar/ });
    expect(within(d).getByText(/Rodadas em andamento serão interrompidas/)).toBeInTheDocument();
    expect(within(d).getByText(/Checkpoint/)).toBeInTheDocument();
    expect(reg.pedidos).toBe(0);
    await userEvent.click(within(d).getByRole("button", { name: "Cancelar" }));
    expect(reg.pedidos).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirmar atualização" }));
    await waitFor(() => expect(reg.pedidos).toBe(1));
    expect(await screen.findByText(/Atualizando/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Atualizar" })).not.toBeInTheDocument();
  });

  it("durante a atualização tolera a API fora do ar e, ao voltar, mostra o resultado com o motivo", async () => {
    const reg = api({});
    render(<App refetchIntervalMs={20} />);
    await userEvent.click(await screen.findByRole("button", { name: "Atualizar" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirmar atualização" }));
    await screen.findByText(/Atualizando/);

    server.use(http.get("*/api/atualizacao", () => HttpResponse.error()));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByText(/Atualizando/)).toBeInTheDocument();

    reg.estado = { ...reg.estado, pedidoPendente: false, ultima: ULTIMA };
    server.use(http.get("*/api/atualizacao", () => HttpResponse.json(reg.estado)));
    const res = await screen.findByRole("status", { name: "Última atualização" });
    expect(res).toHaveTextContent(/rollback/i);
    expect(res).toHaveTextContent("healthcheck falhou após a troca");
    expect(screen.queryByText(/Atualizando/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeInTheDocument();
  });

  it("mostra o resultado de sucesso da última atualização", async () => {
    api({ ultima: { ...ULTIMA, resultado: "sucesso", motivo: "" }, versao: "0.3.0" });
    render(<App />);
    const res = await screen.findByRole("status", { name: "Última atualização" });
    expect(res).toHaveTextContent(/sucesso/i);
    expect(res).toHaveTextContent("v0.3.0");
  });
});
