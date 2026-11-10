// Destino e cabeçalhos do proxy /api -> daemon. Separado do server.js para ser testável sem subir o servidor.

/** Retorna a URL de destino ancorada em `api`, ou null se o pedido não for um caminho /api/... seguro. */
export function destinoDoProxy(reqUrl, api) {
  if (!reqUrl.startsWith("/api/")) return null;
  const resto = reqUrl.slice("/api".length);
  // Precisa começar com uma única "/" (nem "//host" nem "/\host", que o parser WHATWG trata como host).
  if (!resto.startsWith("/") || resto.startsWith("//") || resto.startsWith("/\\")) return null;
  let destino;
  try {
    destino = new URL(resto, api);
  } catch {
    return null;
  }
  return destino.origin === api.origin ? destino : null;
}

const REPASSADOS = ["authorization", "content-type", "accept", "content-length"];

/** Só o que a API precisa; cookies e cabeçalhos de proxy do navegador não seguem adiante. */
export function cabecalhosDoProxy(entrada, api) {
  const saida = {};
  for (const nome of REPASSADOS) if (entrada[nome] !== undefined) saida[nome] = entrada[nome];
  saida.host = api.host;
  return saida;
}
