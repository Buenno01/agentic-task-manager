import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Tarefa } from "@/lib/api";
import type { AcaoAprovacao, AvisoSobreposicao } from "@/lib/api-aprovacao";
import type { ItemHistorico } from "@/lib/api-tarefa";
import { useAcaoAprovacao } from "@/lib/queries-aprovacao";

const ESTADO_PLANO = "Plano pronto para aprovação";
const ESTADO_REJEITADO = "Rejeitado";

/** O plano vigente é o último comentário tipado "plano" do histórico. */
export const planoDoHistorico = (itens: ItemHistorico[]): string | undefined =>
  [...itens].reverse().find((i) => i.tipo === "plano" && i.texto)?.texto;

interface DialogoProps {
  tarefa: Tarefa;
  plano?: string;
  aberto: boolean;
  aoFechar: () => void;
}

/**
 * Diálogo de confirmação da Aprovação: mostra plano, Área prevista e avisos de sobreposição.
 * Nunca aprova sem o clique em "Confirmar aprovação". Reutilizável para Subtarefas (`acao="aprovar-subtarefa"`).
 */
export function DialogoAprovacao({ tarefa, plano, aberto, aoFechar, acao = "aprovar" }: DialogoProps & { acao?: "aprovar" | "aprovar-subtarefa" }) {
  const mut = useAcaoAprovacao(tarefa.id);
  const area = (tarefa.intendedArea as string[] | undefined) ?? [];
  const avisos = (tarefa.overlapWarnings as AvisoSobreposicao[] | undefined) ?? [];

  useEffect(() => {
    if (!aberto) mut.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && aoFechar()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Aprovar: {tarefa.title}</DialogTitle>
          <DialogDescription>Revise o plano e a Área prevista antes de confirmar.</DialogDescription>
        </DialogHeader>
        <section aria-label="Plano" className="text-sm">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Plano</h4>
          {plano ? <p className="whitespace-pre-wrap">{plano}</p> : <p className="text-muted-foreground">Nenhum plano registrado.</p>}
        </section>
        <section aria-label="Área prevista" className="text-sm">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Área prevista</h4>
          {area.length ? (
            <ul className="flex flex-wrap gap-1">
              {area.map((p) => (
                <li key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nenhuma Área prevista informada.</p>
          )}
        </section>
        {avisos.length > 0 && (
          <section aria-label="Avisos de sobreposição" className="rounded-md border border-amber-500/50 p-2 text-sm">
            <h4 className="mb-1 text-xs font-semibold">Sobreposição com outras Tarefas</h4>
            <ul className="flex flex-col gap-1">
              {avisos.map((a) => (
                <li key={a.taskId}>
                  <span className="font-medium">{a.title}</span> <span className="text-muted-foreground">({a.state})</span>
                  <ul className="font-mono text-xs text-muted-foreground">
                    {a.overlaps.map((o) => (
                      <li key={`${o.mine}|${o.theirs}`}>
                        {o.mine} ↔ {o.theirs}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}
        {mut.isError && (
          <p role="alert" className="text-sm text-destructive">
            {mut.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            Cancelar
          </Button>
          <Button disabled={mut.isPending} onClick={() => mut.mutate({ acao }, { onSuccess: aoFechar })}>
            Confirmar aprovação
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rejeição: o motivo é obrigatório. */
export function DialogoRejeicao({ tarefa, aberto, aoFechar }: Omit<DialogoProps, "plano">) {
  const mut = useAcaoAprovacao(tarefa.id);
  const [motivo, setMotivo] = useState("");

  useEffect(() => {
    if (!aberto) {
      setMotivo("");
      mut.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && aoFechar()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rejeitar: {tarefa.title}</DialogTitle>
          <DialogDescription>Informe o motivo da rejeição.</DialogDescription>
        </DialogHeader>
        <textarea
          aria-label="Motivo"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-md border border-input bg-transparent p-2 text-sm dark:bg-input/30"
        />
        {mut.isError && (
          <p role="alert" className="text-sm text-destructive">
            {mut.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={aoFechar}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!motivo.trim() || mut.isPending}
            onClick={() => mut.mutate({ acao: "rejeitar" as AcaoAprovacao, motivo: motivo.trim() }, { onSuccess: aoFechar })}
          >
            Confirmar rejeição
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const emCampo = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true]");

/**
 * Ações de Aprovação do detalhe. A API não expõe as ações permitidas; o mínimo é derivado do estado
 * (GLOSSARY) e a API continua sendo quem rejeita (403/409 aparecem no diálogo). Atalho "a" abre o diálogo.
 */
export function AcoesAprovacao({ tarefa, itens }: { tarefa: Tarefa; itens: ItemHistorico[] }) {
  const [dialogo, setDialogo] = useState<"aprovar" | "rejeitar">();
  const reabrir = useAcaoAprovacao(tarefa.id);
  // Subtarefa proposta pelo agente nasce em "Novo": aprovar-subtarefa, sempre pelo diálogo.
  const subNovo = tarefa.state === "Novo" && !!tarefa.maeId;
  const pronto = tarefa.state === ESTADO_PLANO || subNovo;
  const rejeitado = tarefa.state === ESTADO_REJEITADO;

  useEffect(() => {
    if (!pronto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || emCampo(e)) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      setDialogo("aprovar");
    };
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [pronto]);

  if (!pronto && !rejeitado) return null;
  const fechar = () => setDialogo(undefined);

  return (
    <div className="flex flex-col gap-1 border-b p-3">
      <div className="flex items-center gap-2">
        {pronto && (
          <>
            <Button size="sm" onClick={() => setDialogo("aprovar")} aria-keyshortcuts="A">
              Aprovar
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialogo("rejeitar")}>
              Rejeitar
            </Button>
          </>
        )}
        {rejeitado && (
          <Button size="sm" variant="outline" disabled={reabrir.isPending} onClick={() => reabrir.mutate({ acao: "reabrir" })}>
            Reabrir
          </Button>
        )}
      </div>
      {reabrir.isError && (
        <p role="alert" className="text-xs text-destructive">
          {reabrir.error.message}
        </p>
      )}
      <DialogoAprovacao tarefa={tarefa} plano={planoDoHistorico(itens)} acao={subNovo ? "aprovar-subtarefa" : "aprovar"} aberto={dialogo === "aprovar"} aoFechar={fechar} />
      <DialogoRejeicao tarefa={tarefa} aberto={dialogo === "rejeitar"} aoFechar={fechar} />
    </div>
  );
}
