import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E } from "./ambiente";

// Semeia pela API real, como no fluxo de verdade: agente cria, humano autoriza, agente explora e entrega o plano.
async function chamar(request: APIRequestContext, metodo: string, caminho: string, token: string, data?: unknown) {
  const r = await request.fetch(`${E2E.apiUrl}${caminho}`, { method: metodo, headers: { authorization: `Bearer ${token}` }, data });
  expect(r.ok(), `${metodo} ${caminho} -> ${r.status()} ${await r.text()}`).toBe(true);
  return r;
}

async function semearTarefaComPlanoPronto(request: APIRequestContext, titulo: string) {
  const { id } = await (await chamar(request, "POST", "/tarefas", E2E.tokenAgente, { title: titulo })).json();
  await chamar(request, "POST", `/tarefas/${id}/autorizar`, E2E.tokenHumano);
  await chamar(request, "POST", `/tarefas/${id}/iniciar`, E2E.tokenAgente);
  await chamar(request, "POST", `/tarefas/${id}/comentarios`, E2E.tokenAgente, { tipo: "plano", texto: "Plano E2E: alterar o módulo de relatórios." });
  await chamar(request, "PUT", `/tarefas/${id}/area-prevista`, E2E.tokenAgente, { paths: ["src/relatorios"] });
  await chamar(request, "POST", `/tarefas/${id}/plano-pronto`, E2E.tokenAgente);
  return id as string;
}

test("humano abre o detalhe, confirma no diálogo e a Tarefa vira Aprovado", async ({ page, request }) => {
  const titulo = `Aprovar relatório E2E ${Date.now()}`;
  const id = await semearTarefaComPlanoPronto(request, titulo);
  const estadoNaApi = async () => (await (await chamar(request, "GET", `/tarefas/${id}`, E2E.tokenHumano)).json()).state as string;
  expect(await estadoNaApi()).toBe("Plano pronto para aprovação");

  await page.addInitScript((t) => localStorage.setItem("atm-token", t), E2E.tokenHumano);
  await page.goto(`/tarefas/${id}`);

  const detalhe = page.getByRole("heading", { name: titulo });
  await expect(detalhe.first()).toBeVisible();

  // Antes de confirmar: nenhum diálogo e a Tarefa segue aguardando aprovação.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Aprovar", exact: true }).click();

  // O diálogo é obrigatório: mostra plano e Área prevista, e a Tarefa ainda NÃO está Aprovada.
  const dialogo = page.getByRole("dialog");
  await expect(dialogo).toBeVisible();
  await expect(dialogo.getByText("Plano E2E: alterar o módulo de relatórios.")).toBeVisible();
  await expect(dialogo.getByText("src/relatorios")).toBeVisible();
  expect(await estadoNaApi()).toBe("Plano pronto para aprovação");

  await dialogo.getByRole("button", { name: "Confirmar aprovação" }).click();

  await expect(dialogo).toHaveCount(0);
  await expect.poll(estadoNaApi).toBe("Aprovado");
  await expect(page.locator("span", { hasText: /^Aprovado$/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toHaveCount(0);
});
