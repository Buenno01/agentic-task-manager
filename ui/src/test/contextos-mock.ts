import { http, HttpResponse, server } from "./server";

/** Handlers do básico de Contextos (árvore vazia) para testes que renderizam <App/> sem foco em Contextos. */
export function contextosVazios() {
  server.use(http.get("*/api/contextos/arvore", () => HttpResponse.json([])));
}
