// Servidor estático mínimo da UI. A UI só fala com a API HTTP do daemon.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const tipos = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const raiz = new URL(".", import.meta.url).pathname;
const host = process.env.UI_HOST ?? "127.0.0.1";
const porta = Number(process.env.UI_PORT ?? 5173);

createServer(async (req, res) => {
  const nome = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  if (!/^\/[\w.-]+$/.test(nome) || !tipos[extname(nome)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.writeHead(200, { "content-type": tipos[extname(nome)] }).end(await readFile(join(raiz, nome)));
  } catch {
    res.writeHead(404).end();
  }
}).listen(porta, host, () => console.log(`UI em http://${host}:${porta}`));
