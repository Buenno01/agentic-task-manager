import { CircleAlertIcon, CircleCheckIcon, LoaderIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UltimaAtualizacao } from "@/lib/api-atualizacao";
import { useEstadoAtualizacao, usePedirAtualizacao } from "@/lib/queries-atualizacao";

/**
 * "Atualizando" = pedido pendente na API, ou pedido enviado daqui cuja `ultima` ainda não mudou.
 * Falhas da API durante a troca não alteram nada: a consulta continua em polling e retoma sozinha.
 */
interface Ctx {
  atualizando: boolean;
  iniciar: (emAnterior: string | null) => void;
}
const AtualizacaoCtx = createContext<Ctx | null>(null);
const useAtualizacao = () => {
  const c = useContext(AtualizacaoCtx);
  if (!c) throw new Error("useAtualizacao fora do AtualizacaoProvider");
  return c;
};

export function AtualizacaoProvider({ children }: { children: ReactNode }) {
  const { data } = useEstadoAtualizacao();
  // `base` = `ultima.em` no momento do pedido (null = não havia); undefined = nenhum pedido enviado daqui.
  const [base, setBase] = useState<{ em: string | null } | undefined>();
  const emAtual = data?.ultima?.em ?? null;

  useEffect(() => {
    if (base && data && !data.pedidoPendente && emAtual !== base.em) setBase(undefined);
  }, [base, data, emAtual]);

  const atualizando = !!data?.pedidoPendente || !!base;
  return <AtualizacaoCtx.Provider value={{ atualizando, iniciar: (em) => setBase({ em }) }}>{children}</AtualizacaoCtx.Provider>;
}

/** Versão em execução e, só quando o host configurou a atualização, o botão "Atualizar". */
export function VersaoEAtualizar() {
  const { data } = useEstadoAtualizacao();
  const { atualizando, iniciar } = useAtualizacao();
  const [aberto, setAberto] = useState(false);
  const mut = usePedirAtualizacao();
  if (!data) return null;

  return (
    <div className="flex items-center gap-3">
      {data.versao && <span className="font-mono text-xs text-muted-foreground">v{data.versao}</span>}
      {atualizando && (
        <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" /> Atualizando… a página volta sozinha
        </span>
      )}
      {data.configurada && !atualizando && (
        <Button size="sm" variant="outline" onClick={() => { mut.reset(); setAberto(true); }}>
          Atualizar
        </Button>
      )}
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Atualizar o Agentic Task Manager</DialogTitle>
            <DialogDescription>
              Rodadas em andamento serão interrompidas e retomadas por Checkpoint. A API fica fora do ar por instantes durante a troca.
            </DialogDescription>
          </DialogHeader>
          {mut.isError && (
            <p role="alert" className="text-sm text-destructive">
              {mut.error.message}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            <Button
              disabled={mut.isPending}
              onClick={() =>
                mut.mutate(undefined, {
                  onSuccess: () => {
                    iniciar(data.ultima?.em ?? null);
                    setAberto(false);
                  },
                })
              }
            >
              Confirmar atualização
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const TITULO: Record<UltimaAtualizacao["resultado"], string> = {
  sucesso: "Atualização concluída com sucesso",
  rollback: "Atualização revertida (rollback)",
  erro_rollback: "Erro na atualização e o rollback também falhou",
};

/** Resultado da última atualização (sucesso, rollback ou erro, com o motivo). */
export function ResultadoAtualizacao() {
  const { data } = useEstadoAtualizacao();
  const { atualizando } = useAtualizacao();
  const u = data?.ultima;
  if (!u || atualizando) return null;
  const ruim = u.resultado !== "sucesso";
  return (
    <Alert variant={ruim ? "destructive" : "default"} role="status" aria-label="Última atualização" className="m-6 mb-0 w-auto">
      {ruim ? <CircleAlertIcon /> : <CircleCheckIcon />}
      <AlertTitle>{TITULO[u.resultado]}</AlertTitle>
      <AlertDescription>
        <p>
          {u.tag_de} → {u.tag_para} · rodando v{u.versao_rodando} · {new Date(u.em).toLocaleString("pt-BR")}
        </p>
        {u.motivo && <p>Motivo: {u.motivo}</p>}
      </AlertDescription>
    </Alert>
  );
}
