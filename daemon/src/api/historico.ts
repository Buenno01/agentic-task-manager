import { ErroValidacao } from "../domain/tarefa.ts";
import { TIPOS_COMENTARIO, mesclar, type ItemHistorico, type TipoComentario } from "../domain/historico.ts";
import type { Comentarios } from "../db/comentarios.ts";

export interface Resposta {
  status: number;
  corpo?: unknown;
}

interface Deps {
  comentarios: Comentarios;
  tarefaExiste(id: string): boolean;
  transicoes(id: string): ItemHistorico[];
}

/** Histórico (comentários + transições): só criação e leitura, nunca edição/remoção. */
export function rotaHistorico(
  d: Deps,
  metodo: string,
  path: string,
  autor: string,
  lerCorpo: () => Promise<Record<string, unknown>>,
): Promise<Resposta> | undefined {
  const m = path.match(/^\/tarefas\/([^/]+)\/(eventos|comentarios)(\/[^/]+)?$/);
  if (!m) return undefined;
  const [, id, recurso, sub] = m;
  return (async () => {
    if (!d.tarefaExiste(id)) return { status: 404, corpo: { error: "Não encontrado" } };
    if (recurso === "eventos" && !sub && metodo === "GET")
      return { status: 200, corpo: mesclar(d.transicoes(id), d.comentarios.listar(id)) };
    if (recurso === "comentarios" && !sub && metodo === "POST") {
      const b = await lerCorpo();
      const tipo = (b.tipo ?? "comentario") as TipoComentario;
      if (!TIPOS_COMENTARIO.includes(tipo)) throw new ErroValidacao("Tipo de comentário inválido");
      if (typeof b.texto !== "string" || !b.texto.trim()) throw new ErroValidacao("Texto é obrigatório");
      let respondeA: string | undefined;
      if (tipo === "resposta") {
        const alvo = typeof b.respondeA === "string" ? d.comentarios.obter(b.respondeA) : undefined;
        if (!alvo || alvo.tarefaId !== id || alvo.tipo !== "pergunta")
          throw new ErroValidacao("Resposta deve ligar a uma pergunta da mesma Tarefa");
        respondeA = alvo.id as string;
      } else if (b.respondeA !== undefined) throw new ErroValidacao("Apenas resposta pode ligar a uma pergunta");
      return { status: 201, corpo: d.comentarios.inserir({ tarefaId: id, autor, tipo, texto: b.texto.trim(), respondeA }) };
    }
    if (metodo === "OPTIONS") return { status: 204 };
    return { status: 405, corpo: { error: "Histórico é imutável" } };
  })();
}
