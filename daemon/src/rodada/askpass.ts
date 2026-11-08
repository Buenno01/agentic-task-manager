import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Script GIT_ASKPASS de uma Rodada de Execução: o token fica só no ambiente do processo, nunca em URL de remote nem em arquivo. */
export function criarAskpass(token: string) {
  const dir = mkdtempSync(join(tmpdir(), "atm-askpass-"));
  const script = join(dir, "askpass.sh");
  writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) echo "$ATM_GIT_TOKEN" ;;\nesac\n');
  chmodSync(script, 0o700);
  return {
    ambiente: { GIT_ASKPASS: script, ATM_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    remover: () => rmSync(dir, { recursive: true, force: true }),
  };
}
