// Stub do `hermes chat`: imita o stream-json sem modelo. O comportamento vem da primeira linha do prompt (--query-file).
// Escreve em STUB_REGISTRO (se definido) os argumentos e as chaves de ambiente recebidos.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = readFileSync(args[args.indexOf("--query-file") + 1], "utf8");
if (process.env.STUB_REGISTRO) writeFileSync(process.env.STUB_REGISTRO, JSON.stringify({ args, prompt, env: Object.keys(process.env) }));
const modo = prompt.split("\n")[0].trim();
const out = (o) => process.stdout.write(JSON.stringify({ ...o, timestamp: Date.now() }) + "\n");

out({ type: "system", subtype: "init", model: "stub/modelo-1", session_id: "s1" });
if (modo === "MODO:saida-invalida") process.stdout.write("isto nao e json\n");
if (modo === "MODO:travar") {
  process.on("SIGTERM", () => {}); // ignora SIGTERM: só SIGKILL derruba
  out({ type: "text", text: "pronto" });
  setInterval(() => {}, 1000);
} else if (modo === "MODO:morrer") {
  process.kill(process.pid, "SIGKILL");
} else {
  out({ type: "text", text: "Vou " });
  out({ type: "text", text: "editar." });
  out({ type: "tool_use", name: "write_file", tool_call_id: "t1", input: { path: "a.txt", content: "x" } });
  out({ type: "tool_result", name: "write_file", tool_call_id: "t1", output: "ok", duration_ms: 3, is_error: false });
  out({ type: "tool_use", name: "terminal", input: { command: "git commit -am x" } });
  if (modo === "MODO:falha") {
    out({ type: "result", exit_code: 1, text: "", error: "limite de turnos", tokens: { input: 5, output: 2, total: 7 } });
    process.exit(1);
  }
  if (modo === "MODO:sem-resultado") process.exit(0);
  out({ type: "result", exit_code: 0, text: "feito", tokens: { input: 120, output: 30, total: 150, cache_read: 0, cache_write: 0 } });
}
