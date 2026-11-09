import { useNavigate, useSearch } from "@tanstack/react-router";
import { Command } from "cmdk";
import { InboxIcon, MoonIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TarefaForm } from "@/components/tarefa-form";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ResultadoBusca, TipoResultado } from "@/lib/api";
import { useArvoreContextos, useBusca } from "@/lib/queries";
import { ESTADO_AGUARDANDO } from "@/lib/tarefas";
import { useTema } from "@/lib/theme";

const DEBOUNCE_MS = 250;

const GRUPOS: { tipo: TipoResultado; titulo: string }[] = [
  { tipo: "tarefa", titulo: "Tarefas" },
  { tipo: "comentario", titulo: "Comentários" },
  { tipo: "consolidado", titulo: "Contexto consolidado" },
  { tipo: "anexo", titulo: "Anexos" },
];

const semMarcas = (s: string) => s.replace(/[[\]]/g, "");
const itemCls = "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground";
const grupoCls = "px-1 py-1 text-xs [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground";

/** Ctrl+K em qualquer tela: busca (Tarefas, comentários, consolidado, anexos) e ações. A busca é do daemon. */
export function CommandPalette() {
  const navigate = useNavigate();
  const { contexto } = useSearch({ strict: false }) as { contexto?: string };
  const { alternar } = useTema();
  const arvore = useArvoreContextos().data ?? [];
  const [aberta, setAberta] = useState(false);
  const [criando, setCriando] = useState(false);
  const [texto, setTexto] = useState("");
  const [consulta, setConsulta] = useState("");
  const [subcontextos, setSubcontextos] = useState(true);

  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAberta((a) => !a);
      }
    }
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setConsulta(texto.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [texto]);

  const busca = useBusca(consulta, contexto, subcontextos);
  const resultados = consulta ? (busca.data ?? []) : [];

  function fechar() {
    setAberta(false);
    setTexto("");
    setConsulta("");
  }

  function abrirResultado(r: ResultadoBusca) {
    fechar();
    if (r.taskId) void navigate({ to: "/", search: (p) => ({ ...p, tarefa: r.taskId! }) });
    else if (r.contextId) void navigate({ to: "/", search: (p) => ({ ...p, contexto: r.contextId!, tarefa: undefined }) });
  }

  const acoes = [
    { id: "criar", rotulo: "Criar Tarefa", icone: <PlusIcon />, rodar: () => setCriando(true) },
    {
      id: "inbox",
      rotulo: "Ir para a inbox",
      icone: <InboxIcon />,
      rodar: () => void navigate({ to: "/", search: (p) => ({ ...p, estado: ESTADO_AGUARDANDO, tarefa: undefined }) }),
    },
    { id: "tema", rotulo: "Alternar tema", icone: <MoonIcon />, rodar: alternar },
  ].filter((a) => a.rotulo.toLowerCase().includes(texto.trim().toLowerCase()));

  return (
    <>
      <Dialog open={aberta} onOpenChange={(o) => (o ? setAberta(true) : fechar())}>
        <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 p-0">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">Busque Tarefas, comentários, consolidado e anexos, ou execute uma ação.</DialogDescription>
          <Command shouldFilter={false} label="Command palette">
            <Command.Input
              value={texto}
              onValueChange={setTexto}
              placeholder="Buscar ou executar uma ação…"
              className="h-11 w-full border-b bg-transparent px-3 text-sm outline-none"
            />
            {contexto && (
              <label className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={subcontextos} onChange={(e) => setSubcontextos(e.target.checked)} />
                Incluir sub-Contextos
              </label>
            )}
            <Command.List className="max-h-80 overflow-y-auto p-1">
              {consulta && !busca.isFetching && resultados.length === 0 && acoes.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">Nada encontrado.</p>
              )}
              {GRUPOS.map(({ tipo, titulo }) => {
                const itens = resultados.filter((r) => r.tipo === tipo);
                return (
                  itens.length > 0 && (
                    <Command.Group key={tipo} heading={titulo} className={grupoCls}>
                      {itens.map((r) => (
                        <Command.Item key={`${tipo}-${r.id}-${r.version ?? ""}`} value={`${tipo}-${r.id}-${r.version ?? ""}`} className={itemCls} onSelect={() => abrirResultado(r)}>
                          {semMarcas(r.snippet)}
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )
                );
              })}
              {acoes.length > 0 && (
                <Command.Group heading="Ações" className={grupoCls}>
                  {acoes.map((a) => (
                    <Command.Item
                      key={a.id}
                      value={`acao-${a.id}`}
                      className={itemCls}
                      onSelect={() => {
                        fechar();
                        a.rodar();
                      }}
                    >
                      {a.icone}
                      {a.rotulo}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogContent>
      </Dialog>
      <TarefaForm key={criando ? (contexto ?? "") : "fechado"} open={criando} onOpenChange={setCriando} arvore={arvore} contextoInicial={contexto} />
    </>
  );
}
