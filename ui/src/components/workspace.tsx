import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { MenuIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ArvoreContextos } from "@/components/arvore-contextos";
import { ContextoDetalhe } from "@/components/contexto-detalhe";
import { ContextoForm } from "@/components/contexto-form";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useArvoreContextos, useTarefas } from "@/lib/queries";
import { useTelaLarga } from "@/lib/use-wide";

const rota = getRouteApi("/");

/** Lista de Tarefas (placeholder até o ticket da lista): filtrada pelo Contexto da URL. */
function Lista({ contexto }: { contexto?: string }) {
  const { data } = useTarefas(contexto);
  return (
    <section aria-label="Tarefas" className="p-4 text-sm text-muted-foreground">
      {data?.length ? (
        <ul>
          {data.map((t) => (
            <li key={t.id}>{t.title}</li>
          ))}
        </ul>
      ) : (
        "Nada por aqui ainda."
      )}
    </section>
  );
}

/** Três áreas: sidebar de Contextos | lista | detalhe. Abaixo de 1024 px a sidebar é um drawer. */
export function Workspace() {
  const { contexto } = rota.useSearch();
  const navigate = useNavigate();
  const larga = useTelaLarga();
  const [drawer, setDrawer] = useState(false);
  const [criando, setCriando] = useState(false);
  const arvore = useArvoreContextos().data ?? [];

  const sidebar = (fechar?: () => void) => (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="px-2 text-sm font-semibold">Contextos</h2>
        <Button size="sm" variant="outline" onClick={() => setCriando(true)}>
          <PlusIcon /> Novo Contexto
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ArvoreContextos nos={arvore} selecionado={contexto} aoEscolher={fechar} />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {larga ? (
        <aside aria-label="Barra lateral" className="w-64 shrink-0 border-r p-3">{sidebar()}</aside>
      ) : (
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent>
            <SheetTitle>Contextos</SheetTitle>
            <SheetDescription className="sr-only">Escolha um Contexto para filtrar as Tarefas</SheetDescription>
            {sidebar(() => setDrawer(false))}
          </SheetContent>
        </Sheet>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1 border-b lg:border-r lg:border-b-0">
          {!larga && (
            <div className="border-b p-2">
              <Button size="sm" variant="outline" onClick={() => setDrawer(true)}>
                <MenuIcon /> Contextos
              </Button>
            </div>
          )}
          <Lista contexto={contexto} />
        </div>
        <div className="min-w-0 flex-1" aria-label="Detalhe">
          {contexto ? <ContextoDetalhe id={contexto} /> : <p className="p-4 text-sm text-muted-foreground">Escolha um Contexto para ver o Contexto consolidado.</p>}
        </div>
      </div>
      <ContextoForm
        key={criando ? (contexto ?? "") : "fechado"}
        open={criando}
        onOpenChange={setCriando}
        arvore={arvore}
        paiInicial={contexto}
        aoCriar={(id) => void navigate({ to: "/", search: { contexto: id } })}
      />
    </div>
  );
}
