import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ContextoNo } from "@/lib/api";
import type { ItemHistorico, TipoComentario } from "@/lib/api-tarefa";
import { useArvoreContextos } from "@/lib/queries";
import { useComentar, useHistorico, useTarefa } from "@/lib/queries-tarefa";
import { aparenciaEstado, aparenciaPrioridade, nivelDe } from "@/lib/tarefas";
import { cn } from "@/lib/utils";

const TIPOS_DE_TEXTO = ["comentario", "pergunta", "resposta", "plano"];
const ROTULO: Record<string, string> = { comentario: "Comentário", pergunta: "Pergunta", resposta: "Resposta", plano: "Plano" };

const nomeDoContexto = (nos: ContextoNo[], id: string): string | undefined => {
  for (const n of nos) {
    if (n.id === id) return n.name;
    const f = nomeDoContexto(n.children, id);
    if (f) return f;
  }
};

const quando = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function Item({ item, perguntas, respondidas, aoResponder }: {
  item: ItemHistorico;
  perguntas: Map<string, ItemHistorico>;
  respondidas: Set<string>;
  aoResponder: (p: ItemHistorico) => void;
}) {
  const ehTexto = TIPOS_DE_TEXTO.includes(item.tipo) && item.texto !== undefined;
  const citada = item.respondeA ? perguntas.get(item.respondeA) : undefined;
  return (
    <li className={cn("rounded-md border p-2 text-sm", item.tipo === "pergunta" && "border-amber-500/50")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{ehTexto ? ROTULO[item.tipo] : "Transição"}</span>
        <span>{item.autor}</span>
        <time dateTime={item.em} className="ml-auto">
          {quando(item.em)}
        </time>
      </div>
      {ehTexto ? (
        <>
          {citada && <p className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">Em resposta a: {citada.texto}</p>}
          <p className="mt-1 whitespace-pre-wrap">{item.texto}</p>
          {item.tipo === "pergunta" && !respondidas.has(String(item.id)) && (
            <Button size="sm" variant="outline" className="mt-2" aria-label={`Responder: ${item.texto}`} onClick={() => aoResponder(item)}>
              Responder
            </Button>
          )}
        </>
      ) : (
        <p className="mt-1">
          {item.de || item.para ? `${item.de} → ${item.para}` : item.tipo}
          {item.motivo && <span className="text-muted-foreground"> · {item.motivo}</span>}
        </p>
      )}
    </li>
  );
}

function Compositor({ id, respondendo, aoLimpar }: { id: string; respondendo?: ItemHistorico; aoLimpar: () => void }) {
  const [texto, setTexto] = useState("");
  const comentar = useComentar(id);
  const vazio = !texto.trim();

  function enviar(tipo: TipoComentario) {
    comentar.mutate(
      { tipo, texto: texto.trim(), ...(tipo === "resposta" && respondendo ? { respondeA: String(respondendo.id) } : {}) },
      {
        onSuccess: () => {
          setTexto("");
          if (tipo === "resposta") aoLimpar();
        },
      },
    );
  }

  return (
    <form
      className="flex flex-col gap-2 border-t p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        enviar(respondendo ? "resposta" : "comentario");
      }}
    >
      {respondendo && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Respondendo a: {respondendo.texto}</span>
          <button type="button" aria-label="Cancelar resposta" className="rounded p-0.5 hover:bg-accent" onClick={aoLimpar}>
            <XIcon className="size-3.5" />
          </button>
        </p>
      )}
      <textarea
        aria-label="Comentário"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-transparent p-2 text-sm dark:bg-input/30"
      />
      {comentar.isError && (
        <p role="alert" className="text-xs text-destructive">
          {comentar.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {respondendo ? (
          <Button type="submit" size="sm" disabled={vazio || comentar.isPending}>
            Responder
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" disabled={vazio || comentar.isPending} onClick={() => enviar("pergunta")}>
              Perguntar
            </Button>
            <Button type="submit" size="sm" disabled={vazio || comentar.isPending}>
              Comentar
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** Painel de detalhe da Tarefa. Esc (fora de campos/diálogos) fecha e remove `?tarefa=` da URL, mantendo os filtros. */
export function DetalheTarefa({ id }: { id: string }) {
  const navigate = useNavigate();
  const tarefa = useTarefa(id);
  const historico = useHistorico(id);
  const arvore = useArvoreContextos().data ?? [];
  const [respondendo, setRespondendo] = useState<ItemHistorico>();

  const fechar = () => void navigate({ to: "/", search: (prev) => ({ ...prev, tarefa: undefined }) });

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog], [data-radix-popper-content-wrapper]")) return;
      void navigate({ to: "/", search: (prev) => ({ ...prev, tarefa: undefined }) });
    };
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [navigate]);

  const itens = historico.data ?? [];
  const perguntas = new Map(itens.filter((i) => i.tipo === "pergunta").map((i) => [String(i.id), i]));
  const respondidas = new Set(itens.filter((i) => i.tipo === "resposta" && i.respondeA).map((i) => i.respondeA as string));

  const t = tarefa.data;
  const contexto = t?.contextId ? nomeDoContexto(arvore, t.contextId) : undefined;
  const estado = t && aparenciaEstado(t.state);
  const nivel = t && nivelDe(t);
  const prio = nivel && aparenciaPrioridade(nivel);

  return (
    <section aria-label="Detalhe da Tarefa" className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          {t ? (
            <>
              <h2 className="text-base font-semibold">{t.title}</h2>
              <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <dt className="sr-only">Estado</dt>
                <dd className="flex items-center gap-1">
                  {estado && <estado.icone className={cn("size-3.5", estado.cor)} aria-hidden />}
                  <span>{t.state}</span>
                </dd>
                <dt className="sr-only">Prioridade</dt>
                <dd className="flex items-center gap-1">
                  {prio && <prio.icone className={cn("size-3.5", prio.cor)} aria-hidden />}
                  <span>{nivel}</span>
                </dd>
                {contexto && (
                  <>
                    <dt className="text-muted-foreground">Contexto</dt>
                    <dd>{contexto}</dd>
                  </>
                )}
              </dl>
              {t.description && <p className="mt-2 whitespace-pre-wrap text-sm">{t.description}</p>}
            </>
          ) : tarefa.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {tarefa.error.message}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          )}
        </div>
        <Button size="icon" variant="ghost" aria-label="Fechar detalhe" onClick={fechar}>
          <XIcon />
        </Button>
      </div>
      {/* Slot das ações de Aprovação (tickets 06 e 08): renderizar aqui, com `t` e o histórico. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Histórico</h3>
        {itens.length === 0 && !historico.isPending ? (
          <p className="text-sm text-muted-foreground">Sem histórico ainda.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {itens.map((i) => (
              <Item key={`${i.tipo}-${i.id}`} item={i} perguntas={perguntas} respondidas={respondidas} aoResponder={setRespondendo} />
            ))}
          </ol>
        )}
      </div>
      <Compositor key={id} id={id} respondendo={respondendo} aoLimpar={() => setRespondendo(undefined)} />
    </section>
  );
}
