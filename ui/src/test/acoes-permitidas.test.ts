import { describe, expect, it } from "vitest";
import { acoesPermitidas } from "@/lib/tarefas";

const base = { autorizar: false, aprovar: false, rejeitar: false, reabrir: false, forcarInicio: false };

describe("acoesPermitidas", () => {
  it("Novo: só autorizar; subtarefa Nova também aprova e rejeita", () => {
    expect(acoesPermitidas({ state: "Novo" })).toEqual({ ...base, autorizar: true });
    expect(acoesPermitidas({ state: "Novo", subtarefa: true })).toEqual({ ...base, autorizar: true, aprovar: true, rejeitar: true });
  });

  it("Plano pronto para aprovação: aprovar e rejeitar", () => {
    expect(acoesPermitidas({ state: "Plano pronto para aprovação" })).toEqual({ ...base, aprovar: true, rejeitar: true });
  });

  it("Rejeitado: reabrir", () => {
    expect(acoesPermitidas({ state: "Rejeitado" })).toEqual({ ...base, reabrir: true });
  });

  it("Forçar início só em Autorizada para explorar com Dependência pendente", () => {
    expect(acoesPermitidas({ state: "Autorizada para explorar", pendentes: 1 })).toEqual({ ...base, forcarInicio: true });
    expect(acoesPermitidas({ state: "Autorizada para explorar", pendentes: 0 })).toEqual(base);
    expect(acoesPermitidas({ state: "Explorando", pendentes: 2 })).toEqual(base);
  });
});
