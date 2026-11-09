import { setupServer } from "msw/node";

// Servidor MSW compartilhado. Cada teste registra seus handlers com `server.use(...)`;
// o setup global reseta após cada teste e falha em requisição sem handler (onUnhandledFrame: error).
export const server = setupServer();
export { http, HttpResponse } from "msw";
