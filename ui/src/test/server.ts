import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Servidor MSW compartilhado. Cada teste registra seus handlers com `server.use(...)`;
// o setup global reseta após cada teste e falha em requisição sem handler (onUnhandledFrame: error).
export const server = // Padrão: atualização não configurada, para os testes que não tratam dela; o teste específico a sobrescreve.
setupServer(
  http.get("*/api/atualizacao", () =>
    HttpResponse.json({ versao: null, configurada: false, estado: "indisponivel", pedidoPendente: false, ultima: null }),
  ),
);
export { http, HttpResponse } from "msw";
