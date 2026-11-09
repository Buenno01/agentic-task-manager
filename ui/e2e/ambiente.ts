// Configuração do ambiente de E2E. Tokens descartáveis, válidos só neste ambiente de teste (nunca use em produção).
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiPorta = 4391;
const uiPorta = 4392;

export const E2E = {
  apiPorta,
  uiPorta,
  apiUrl: `http://127.0.0.1:${apiPorta}`,
  uiUrl: `http://127.0.0.1:${uiPorta}`,
  // Banco novo por execução: o npm script `e2e` o apaga antes de subir o daemon.
  dbPath: join(tmpdir(), "atm-ui-e2e", "atm.db"),
  tokenHumano: "e2e-humano-k7Qp2vXw9LmZr4Ts",
  tokenAgente: "e2e-agente-Hn3Yb8CdF5GjU6Rt",
  tokenOrquestrador: "e2e-orquestrador-Vs1Ae9NxK2PmQ7Wd",
};
