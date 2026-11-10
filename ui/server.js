// Servidor estático enxuto do build (dist/), com fallback de SPA para index.html.
// Repassa /api/* ao daemon (ATM_API_URL), removendo o prefixo: a SPA fala com a API no mesmo origin, sem CORS.
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { cabecalhosDoProxy, destinoDoProxy } from "./proxy.js";

const tipos = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
};
const raiz = join(new URL(".", import.meta.url).pathname, "dist");
const host = process.env.UI_HOST ?? "127.0.0.1";
const porta = Number(process.env.UI_PORT ?? 5173);
const api = new URL(process.env.ATM_API_URL ?? "http://127.0.0.1:3000");

function repassar(req, res) {
  const destino = destinoDoProxy(req.url, api);
  if (!destino) return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Caminho inválido" }));
  const saida = httpRequest(destino, { method: req.method, headers: cabecalhosDoProxy(req.headers, api) }, (resp) => {
    res.writeHead(resp.statusCode ?? 502, resp.headers);
    resp.pipe(res);
  });
  saida.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "API indisponível" }));
  });
  req.pipe(saida);
}

async function servir(caminho) {
  const corpo = await readFile(join(raiz, caminho));
  return [corpo, tipos[extname(caminho)] ?? "application/octet-stream"];
}

createServer(async (req, res) => {
  if (req.url === "/api" || req.url.startsWith("/api/")) return repassar(req, res);
  const url = new URL(req.url, "http://x");
  let pedido;
  try {
    pedido = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    return void res.writeHead(400).end();
  }
  try {
    const [corpo, tipo] = await servir(pedido === "/" || pedido === "." ? "index.html" : pedido);
    const cache = pedido.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "content-type": tipo, "cache-control": cache }).end(corpo);
  } catch {
    // Rota desconhecida (sem extensão) cai no index.html; arquivo ausente é 404.
    if (extname(pedido)) return void res.writeHead(404).end();
    const [corpo, tipo] = await servir("index.html");
    res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" }).end(corpo);
  }
}).listen(porta, host, () => console.log(`UI em http://${host}:${porta}`));
