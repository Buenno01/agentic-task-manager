import type { Credenciais } from "../src/auth/credenciais.ts";

/** Credenciais de teste compartilhadas (startDaemon exige credenciais explícitas). */
export const HUMANO = "tok-humano";
export const AGENTE = "tok-agente";
export const CRED: Credenciais = { humano: HUMANO, agentes: { "agente-a": AGENTE } };

export const comToken = (token: string, extra: Record<string, string> = {}) => ({
  ...extra,
  authorization: `Bearer ${token}`,
});
