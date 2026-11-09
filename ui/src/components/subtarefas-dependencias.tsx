import { useState, type FormEvent } from "react";
import { AvisoDependencia } from "@/components/aviso-dependencia";
import { DialogoAprovacao, DialogoRejeicao, planoDoHistorico } from "@/components/acoes-aprovacao";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Tarefa } from "@/lib/api";
import { dependeDe, pendentesDe, subtarefasDe, type ResumoSubtarefa } from "@/lib/api-subtarefas";
import { useAcaoAprovacao } from "@/lib/queries-aprovacao";
import { useAdicionarDependencia, useAjustarSubtarefa, useRemoverDependencia } from "@/lib/queries-subtarefas";
import { useTarefas } from "@/lib/queries";
import { useHistorico, useTarefa } from "@/lib/queries-tarefa";
import { aparenciaEstado } from "@/lib/tarefas";
import { cn } from "@/lib/utils";

const campoCls = "w-full rounded-md border border-input bg-transparent p-2 text-sm dark:bg-input/30";

function FormAjuste({ tarefa, aoFechar }: { tarefa: Tarefa; aoFechar: () => void }) {
  const [titulo, setTitulo] = useState(tarefa.title);
  const [descricao, setDescricao] = useState(tarefa.description);
  const ajustar = useAjustarSubtarefa(tarefa.id);

  function salvar(e: FormEvent) {
    e.preventDefault();
    ajustar.mutate({ title: titulo.trim(), description: descricao }, { onSuccess: aoFechar });
  }

  return (
    <form onSubmit={salvar} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs">
        Título
        <input aria-label="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} className={campoCls} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Descrição
        <textarea aria-label="Descrição" rows={4} value={descricao} onChange={(e) => setDescricao(e.target.value)} className={campoCls} />
      </label>
      {ajustar.isError && (
        <p role="alert" className="text-sm text-destructive">
          {ajustar.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={aoFechar}>
          Cancelar
        </Button>
        <Button type="submit" disabled={!titulo.trim() || ajustar.isPending}>
          Salvar
        </Button>
      </DialogFooter>
    </form>
  );
}

function DialogoAjuste({ id, titulo, tarefa, aberto, aoFechar }: { id: string; titulo: string; tarefa?: Tarefa; aberto: boolean; aoFechar: () => void }) {
  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && aoFechar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar: {titulo}</DialogTitle>
          <DialogDescription>Edite o título e a descrição da Subtarefa.</DialogDescription>
        </DialogHeader>
        {tarefa ? <FormAjuste key={id} tarefa={tarefa} aoFechar={aoFechar} /> : <p className="text-sm text-muted-foreground">Carregando…</p>}
      </DialogContent>
    </Dialog>
  );
}

/** Uma Subtarefa: ações individuais conforme o estado dela (GLOSSARY); a API segue sendo quem valida. */
function ItemSubtarefa({ resumo, aoAbrir }: { resumo: ResumoSubtarefa; aoAbrir: (id: string) => void }) {
  const [dialogo, setDialogo] = useState<"aprovar" | "rejeitar" | "ajustar">();
  const completa = useTarefa(resumo.id);
  const historico = useHistorico(resumo.id);
  const reabrir = useAcaoAprovacao(resumo.id);
  const { icone: Icone, cor } = aparenciaEstado(resumo.state);

  // Antes de a Tarefa completa chegar, o diálogo usa o resumo da mãe.
  const tarefa: Tarefa =
    completa.data ?? { id: resumo.id, title: resumo.title, state: resumo.state, description: "", phase: "Exploração", createdAt: "" };
  const fechar = () => setDialogo(undefined);
  const novo = resumo.state === "Novo";
  const aprovavel = novo || resumo.state === "Plano pronto para aprovação";
  const rejeitavel = aprovavel;
  const rejeitada = resumo.state === "Rejeitado";

  return (
    <li className="rounded-md border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Icone className={cn("size-4 shrink-0", cor)} aria-hidden />
        <button type="button" aria-label={`Abrir ${resumo.title}`} className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => aoAbrir(resumo.id)}>
          {resumo.title}
        </button>
        <span className="text-xs text-muted-foreground">{resumo.state}</span>
        {aprovavel && (
          <Button size="sm" aria-label={`Aprovar ${resumo.title}`} onClick={() => setDialogo("aprovar")}>
            Aprovar
          </Button>
        )}
        {rejeitavel && (
          <Button size="sm" variant="outline" aria-label={`Rejeitar ${resumo.title}`} onClick={() => setDialogo("rejeitar")}>
            Rejeitar
          </Button>
        )}
        {rejeitada && (
          <Button size="sm" variant="outline" aria-label={`Reabrir ${resumo.title}`} disabled={reabrir.isPending} onClick={() => reabrir.mutate({ acao: "reabrir" })}>
            Reabrir
          </Button>
        )}
        {novo && (
          <Button size="sm" variant="ghost" aria-label={`Ajustar ${resumo.title}`} onClick={() => setDialogo("ajustar")}>
            Ajustar
          </Button>
        )}
      </div>
      {reabrir.isError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {reabrir.error.message}
        </p>
      )}
      <DialogoAprovacao
        tarefa={tarefa}
        plano={planoDoHistorico(historico.data ?? [])}
        acao={novo ? "aprovar-subtarefa" : "aprovar"}
        aberto={dialogo === "aprovar"}
        aoFechar={fechar}
      />
      <DialogoRejeicao tarefa={tarefa} aberto={dialogo === "rejeitar"} aoFechar={fechar} />
      <DialogoAjuste id={resumo.id} titulo={resumo.title} tarefa={completa.data} aberto={dialogo === "ajustar"} aoFechar={fechar} />
    </li>
  );
}

/** Subtarefas da mãe no detalhe, cada uma com suas ações individuais. */
export function SecaoSubtarefas({ tarefa, aoAbrir }: { tarefa: Tarefa; aoAbrir: (id: string) => void }) {
  const subs = subtarefasDe(tarefa);
  if (subs.length === 0) return null;
  return (
    <section aria-label="Subtarefas" className="border-b p-3">
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Subtarefas</h3>
      <ul className="flex flex-col gap-2">
        {subs.map((s) => (
          <ItemSubtarefa key={s.id} resumo={s} aoAbrir={aoAbrir} />
        ))}
      </ul>
    </section>
  );
}

/** Dependências no detalhe: aviso brando de pendência, adicionar e remover. Nunca bloqueia nada. */
export function SecaoDependencias({ tarefa }: { tarefa: Tarefa }) {
  const todas = useTarefas().data ?? [];
  const adicionar = useAdicionarDependencia(tarefa.id);
  const remover = useRemoverDependencia(tarefa.id);
  const [escolha, setEscolha] = useState("");
  const ids = dependeDe(tarefa);
  const pendentes = pendentesDe(tarefa);
  const nome = (id: string) => todas.find((t) => t.id === id)?.title ?? pendentes.find((p) => p.id === id)?.title ?? id;
  const candidatas = todas.filter((t) => t.id !== tarefa.id && !ids.includes(t.id));
  const erro = adicionar.isError ? adicionar.error.message : remover.isError ? remover.error.message : undefined;

  return (
    <section aria-label="Dependências" className="border-b p-3">
      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Dependências</h3>
      {ids.length === 0 ? (
        <p className="text-sm text-muted-foreground">Esta Tarefa não depende de outra.</p>
      ) : (
        <>
          <p className="mb-1 text-xs text-muted-foreground">Aviso brando: não impede mover a Tarefa.</p>
          <ul className="flex flex-col gap-1">
            {ids.map((id) => {
              const p = pendentes.find((x) => x.id === id);
              return (
                <li key={id} className="flex items-center gap-2 text-sm">
                  {p && <AvisoDependencia titulo={nome(id)} pendentes={[p]} />}
                  <span className="min-w-0 flex-1 truncate">{nome(id)}</span>
                  {p && <span className="text-xs text-amber-500">{`${p.state} · pendente`}</span>}
                  <Button size="sm" variant="ghost" aria-label={`Remover dependência de ${nome(id)}`} disabled={remover.isPending} onClick={() => remover.mutate(id)}>
                    Remover
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (escolha) adicionar.mutate(escolha, { onSuccess: () => setEscolha("") });
        }}
      >
        <select aria-label="Depende de" value={escolha} onChange={(e) => setEscolha(e.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30">
          <option value="">Escolher Tarefa…</option>
          {candidatas.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={!escolha || adicionar.isPending}>
          Adicionar dependência
        </Button>
      </form>
      {erro && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {erro}
        </p>
      )}
    </section>
  );
}
