import { http, HttpResponse, server } from "./server";

describe("harness MSW", () => {
  it("responde com o handler registrado no teste", async () => {
    server.use(http.get("http://api.test/tarefas", () => HttpResponse.json([{ id: "t1" }])));
    const res = await fetch("http://api.test/tarefas");
    expect(await res.json()).toEqual([{ id: "t1" }]);
  });
});

describe("harness MSW (sem handler)", () => {
  it("falha requisição sem handler", async () => {
    await expect(fetch("http://api.test/sem-handler")).rejects.toThrow();
  });
});
