import type { IncomingMessage } from "node:http";

/**
 * Lê o corpo da requisição até `max` bytes. Ao cruzar o limite para na hora (sem armazenar o resto)
 * e devolve null; o chamador responde 413. O stream não é destruído, para a resposta poder sair.
 */
export async function lerCorpoLimitado(req: IncomingMessage, max: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"]) > max) return null;
  const partes: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > max) return null;
    partes.push(chunk);
  }
  return Buffer.concat(partes);
}

/** Corpo grande demais (413). */
export class ErroCorpoGrande extends Error {}

export const LIMITE_JSON = 1024 * 1024;
